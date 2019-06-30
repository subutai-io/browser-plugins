'use strict';

define(function(require, exports, module) {

  var porto = require('../porto-lib').porto;
  var l10n = porto.l10n.get;
  var openpgp = require('openpgp');
  var defaults = require('./defaults');
  var prefs = require('./prefs');
  var pwdCache = require('./pwdCache');
  var crypto = require('./crypto');

  var goog = require('./closure-library/closure/goog/emailaddress').goog;
  var keyring = require('./keyring');
  var keyringSync = require('./keyringSync');

  var watchListBuffer = null;
  var managementListBuffer = null;

  function init() {
    defaults.init();
    prefs.init();
    pwdCache.init();
    initOpenPGP();
    keyring.init();
  }

  function initOpenPGP() {
    openpgp.config.commentstring = 'https://subutai.io/';
    openpgp.config.versionstring = 'Subutai v' + defaults.getVersion();
    openpgp.initWorker('openpgp.worker.js');
  }

  exports.init = init;

  /*
   function decode_utf8(str) {
   // if str contains umlauts (öäü) this throws an exeception -> no decoding required
   try {
   return decodeURIComponent(escape(str));
   } catch (e) {
   return str;
   }
   }
   */

  function validateEmail(email) {
    return goog.format.EmailAddress.isValidAddrSpec(email);
  }

  function readMessage(armoredText, keyringId) {
    return new Promise(function(resolve, reject) {
      var result = {};
      try {
        result.message = openpgp.message.readArmored(armoredText);
      } catch (e) {
        return reject({
          type: 'error',
          message: l10n('message_read_error', [e])
        });
      }

      result.key = null;
      result.userid = '';
      result.keyid = null;

      var encryptionKeyIds = result.message.getEncryptionKeyIds();
      for (var i = 0; i < encryptionKeyIds.length; i++) {
        result.keyid = encryptionKeyIds[i].toHex();
        result.key = keyring.getById(keyringId).keyring.privateKeys.getForId(result.keyid, true);
        if (result.key) {
          break;
        }
      }

      if (result.key) {
        result.userid = keyring.getUserId(result.key, false);
      } else {
        // unknown private key
        result.keyid = encryptionKeyIds[0].toHex();
        var message = l10n("message_no_keys", [result.keyid.toUpperCase()]);
        for (var i = 1; i < encryptionKeyIds.length; i++) {
          message = message + ' ' + l10n("word_or") + ' ' + encryptionKeyIds[i].toHex().toUpperCase();
        }
        return reject({
          type: 'error',
          message: message,
        });
      }

      resolve(result);
    });
  }

  function readCleartextMessage(armoredText, keyringId) {
    var result = {};
    try {
      result.message = openpgp.cleartext.readArmored(armoredText);
    } catch (e) {
      throw {
        type: 'error',
        message: l10n('cleartext_read_error', [e])
      };
    }

    result.signers = [];
    var signingKeyIds = result.message.getSigningKeyIds();
    if (signingKeyIds.length === 0) {
      throw {
        type: 'error',
        message: 'No signatures found'
      };
    }
    for (var i = 0; i < signingKeyIds.length; i++) {
      var signer = {};
      signer.keyid = signingKeyIds[i].toHex();
      signer.key = keyring.getById(keyringId).keyring.getKeysForId(signer.keyid, true);
      signer.key = signer.key ? signer.key[0] : null;
      if (signer.key) {
        signer.userid = keyring.getUserId(signer.key);
      }
      result.signers.push(signer);
    }

    return result;
  }

  function unlockKey(privKey, keyid, passwd, callback) {
    return openpgp.decryptKey({privateKey: privKey, passphrase: passwd})
    .then(result => result.key)
    .catch(e => {
      if (/Invalid passphrase/.test(e.message)) {
        porto.util.throwError('Could not unlock key: wrong password', 'WRONG_PASSWORD');
      } else {
        porto.util.throwError('Error in openpgp.decryptKey');
      }
    });
  }

  function decryptMessage(message, keyringId, callback) {
    if (message.options && message.options.senderAddress) {
      var keyRing = keyring.getById(keyringId);
      var signingKeys = keyRing.getKeyByAddress([message.options.senderAddress], {validity: true});
      signingKeys = signingKeys[message.options.senderAddress] || [message.key];

      openpgp.decrypt({message: message.message, privateKey: message.key, publicKeys: signingKeys})
      .then(result => {
        result.signatures = result.signatures.map(function(signature) {
          signature.keyid = signature.keyid.toHex();
          if (signature.valid !== null) {
            var signingKey = keyRing.keyring.getKeysForId(signature.keyid, true);
            signature.keyDetails = keyring.mapKeys(signingKey)[0];
          }
          return signature;
        });
        callback(null, result);
      });
    } else {
      openpgp.getWorker().decryptMessage(message.key, message.message).then(function(result) {
        callback(null, {text: result});
      }, callback);
    }
  }

  function decrypt(armored, key) {
    var msg = openpgp.message.readArmored(armored);
    return openpgp.decrypt({message: msg, privateKey: key, format:'utf8'});
  }

  /**
   * @param {Object} options
   * @param {String} options.keyIdsHex
   * @param {String} options.keyringId
   * @param {String} options.message  message as native JavaScript string
   * @returns {Promise<String.{type: String, code: String, message: String}>}
   */
  function encryptMessage(options) {
    return new Promise(function(resolve, reject) {
      var keys = options.keyIdsHex.map(function(keyIdHex) {
        var keyArray = keyring.getById(options.keyringId).keyring.getKeysForId(keyIdHex);
        return keyArray ? keyArray[0] : null;
      }).filter(function(key) {
        return key !== null;
      });

      if (keys.length === 0) {
        reject({
          type: 'error',
          message: 'No key found for encryption'
        });
      } else {
        openpgp.encrypt({data: options.message, publicKeys: keys})
        .then(msg => {
          // logEncryption(uiLogSource, keys);
          return msg.data;
        })
        .catch(e => {
          throw {
            code: 'ENCRYPT_ERROR',
            message: l10n('encrypt_error', [e])
          };
        });
      }
    });
  }

  function encrypt(textToEncrypt, key, that) {
    return openpgp.encrypt({data: textToEncrypt, publicKeys: key, armor: true});
  }

  /**
   * @param {Object} options
   * @param {String} options.keyIdsHex
   * @param {String} options.keyringId
   * @param {String} options.message  message as native JavaScript string
   * @param {Object} options.primaryKey
   * @return {Promise.<String>}
   */
  function signAndEncryptMessage(options) {
    return new Promise(function(resolve, reject) {
      var keys = options.keyIdsHex.map(function(keyIdHex) {
        var keyArray = keyring.getById(options.keyringId).keyring.getKeysForId(keyIdHex);
        return keyArray ? keyArray[0] : null;
      }).filter(function(key) {
        return key !== null;
      });

      if (keys.length === 0) {
        reject({
          type: 'error',
          code: 'NO_KEY_FOUND_FOR_ENCRYPTION',
          message: 'No key found for encryption'
        });
      } else {
        openpgp.getWorker().signAndEncryptMessage(keys, options.primaryKey.key, options.message)
          .then(function(msg) {
            resolve(msg);
          })
          .catch(function(e) {
            reject({
              type: 'error',
              code: 'ENCRYPT_ERROR',
              message: l10n('encrypt_error', [e])
            });
          });
      }
    });
  }

  function verifyMessage(message, signers, callback) {
    var keys = signers.map(function(signer) {
      return signer.key;
    }).filter(function(key) {
      return key !== null;
    });
    openpgp.verify({message, publicKeys: keys})
    .then((signatures) => {
      signers = signers.map(signer => {
        signer.valid = signer.key && signatures.some(verifiedSig => signer.keyid === verifiedSig.keyid.toHex() && verifiedSig.valid);
        // remove key object
        delete signer.key;
        return signer;
      });
      callback(null, signers);
    })
    .catch(e => {
      callback({
        type: 'error',
        message: l10n('verify_error', [e])
      });
    });
  }

  /**
   * @param {String} message
   * @param {String} signKey
   * @return {Promise<String>}
   */
  function signMessage(message, signKey) {
    return openpgp.sign({data: message, privateKeys: signKey})
    .then(msg => msg.data);
  }

  function createPrivateKeyBackup(primaryKey, keyPwd) {
    // create backup code
    var backupCode = crypto.randomString(26);
    // create packet structure
    var packetList = new openpgp.packet.List();
    var literal = new openpgp.packet.Literal();
    var text = 'Version: 1\n';
    text += 'Pwd: ' + keyPwd + '\n';
    literal.setText(text);
    packetList.push(literal);
    packetList.concat(primaryKey.toPacketlist());
    // symmetrically encrypt with backup code
    var msg = new openpgp.message.Message(packetList);
    msg = msg.symEncrypt(backupCode);
    return {
      backupCode: backupCode,
      message: msg.armor()
    };
  }

  function parseMetaInfo(txt) {
    var result = {};
    txt.replace(/\r/g, '').split('\n').forEach(function(row) {
      if (row.length) {
        var keyValue = row.split(/:\s/);
        result[keyValue[0]] = keyValue[1];
      }
    });
    return result;
  }

  function restorePrivateKeyBackup(armoredBlock, code) {
    //console.log('restorePrivateKeyBackup', armoredBlock);
    try {
      var message = openpgp.message.readArmored(armoredBlock);
      try {
        message = message.symDecrypt(code);
      } catch (e) {
        return {error: {message: 'Could not decrypt message with this restore code', code: 'WRONG_RESTORE_CODE'}};
      }
      // extract password
      var pwd = parseMetaInfo(message.getText()).Pwd;
      // remove literal data packet
      var keyPackets = message.packets.slice(1);
      var privKey = new openpgp.key.Key(keyPackets);
      return {key: privKey, password: pwd};
    } catch (e) {
      return {error: e.message};
    }
  }

  /**
   * @param  {openpgp.key.Key} key - key to decrypt and verify signature
   * @param  {openpgp.message.Message} message - sync packet
   * @return {Promise<Object,Error>}
   */
  function decryptSyncMessage(key, message) {
    return openpgp.decrypt({message, privateKey: key, publicKeys: key})
      .then(function(msg) {
        // check signature
        var sig = msg.signatures[0];
        if (!(sig && sig.valid && sig.keyid.equals(key.getSigningKeyPacket().getKeyId()))) {
          throw new Error('Signature of synced keyring is invalid');
        }
        var syncData = JSON.parse(msg.text);
        var publicKeys = [];
        var changeLog = {};
        for (var fingerprint in syncData.insertedKeys) {
          publicKeys.push({
            type: 'public',
            armored: syncData.insertedKeys[fingerprint].armored
          });
          changeLog[fingerprint] = {
            type: keyringSync.INSERT,
            time: syncData.insertedKeys[fingerprint].time
          };
        }
        for (var fingerprint in syncData.deletedKeys) {
          changeLog[fingerprint] = {
            type: keyringSync.DELETE,
            time: syncData.deletedKeys[fingerprint].time
          };
        }
        return {
          changeLog: changeLog,
          keys: publicKeys
        };
      });
  }

  /**
   * @param  {Key} key - used to sign and encrypt the package
   * @param  {Object} changeLog
   * @param  {String} keyringId - selects keyring for the sync
   * @return {Promise<Object, Error>} - the encrypted message and the own public key
   */
  function encryptSyncMessage(key, changeLog, keyringId) {
    return Promise.resolve()
    .then(() => {
      var syncData = {};
      syncData.insertedKeys = {};
      syncData.deletedKeys = {};
      var keyRing = keyring.getById(keyringId).keyring;
      keyRing.publicKeys.keys.forEach(function(pubKey) {
        convertChangeLog(pubKey, changeLog, syncData);
      });
      keyRing.privateKeys.keys.forEach(function(privKey) {
        convertChangeLog(privKey.toPublic(), changeLog, syncData);
      });
      for (var fingerprint in changeLog) {
        if (changeLog[fingerprint].type === keyringSync.DELETE) {
          syncData.deletedKeys[fingerprint] = {
            time: changeLog[fingerprint].time
          };
        }
      }
      syncData = JSON.stringify(syncData);
      return openpgp.encrypt({data: syncData, publicKeys: key, privateKeys: key})
      .then(msg => msg.data);
    });
  }

  function convertChangeLog(key, changeLog, syncData) {
    var fingerprint = key.primaryKey.getFingerprint();
    var logEntry = changeLog[fingerprint];
    if (!logEntry) {
      console.log('Key ' + fingerprint + ' in keyring but not in changeLog.');
      return;
    }
    if (logEntry.type === keyringSync.INSERT) {
      syncData.insertedKeys[fingerprint] = {
        armored: key.armor(),
        time: logEntry.time
      };
    } else if (logEntry.type === keyringSync.DELETE) {
      console.log('Key ' + fingerprint + ' in keyring but has DELETE in changeLog.');
    } else {
      console.log('Invalid changeLog type:', logEntry.type);
    }
  }

  function getLastModifiedDate(key) {
    var lastModified = new Date(0);
    key.toPacketlist().forEach(function(packet) {
      if (packet.created && packet.created > lastModified) {
        lastModified = packet.created;
      }
    });
    return lastModified;
  }

  exports.validateEmail = validateEmail;
  exports.readMessage = readMessage;
  exports.readCleartextMessage = readCleartextMessage;
  exports.decryptMessage = decryptMessage;
  exports.decrypt = decrypt;
  exports.unlockKey = unlockKey;
  exports.encryptMessage = encryptMessage;
  exports.encrypt = encrypt;
  exports.signAndEncryptMessage = signAndEncryptMessage;
  exports.signMessage = signMessage;
  exports.verifyMessage = verifyMessage;
  exports.createPrivateKeyBackup = createPrivateKeyBackup;
  exports.restorePrivateKeyBackup = restorePrivateKeyBackup;
  exports.decryptSyncMessage = decryptSyncMessage;
  exports.encryptSyncMessage = encryptSyncMessage;
  exports.getLastModifiedDate = getLastModifiedDate;

  function getManagementList() {
    managementListBuffer = managementListBuffer || porto.storage.get("managementList");
    managementListBuffer = managementListBuffer || [];
    if (!managementListBuffer) {
      managementListBuffer = [];
    }
    if (!Array.isArray(managementListBuffer)) {
      managementListBuffer = [managementListBuffer];
    }
    return managementListBuffer;
  }

  function setManagementList(managementList) {
    if (!managementList) {
      managementListBuffer = [];
    }
    else {
      managementListBuffer = managementList;
    }
    if (!Array.isArray(managementListBuffer)) {
      managementListBuffer = [managementListBuffer];
    }
    porto.storage.set('managementList', managementListBuffer);
  }

  function getWatchList() {
    watchListBuffer = watchListBuffer || porto.storage.get('e2eWatchList');
    return watchListBuffer;
  }

  function setWatchList(watchList) {
    porto.storage.set('e2eWatchList', watchList);
    watchListBuffer = watchList;
  }

  function getHostname(url) {
    var hostname = porto.util.getHostname(url);
    // limit to 3 labels per domain
    return hostname.split('.').slice(-3).join('.');
  }

  function getBaseName(url) {
    return porto.util.getHostname(url);
  }

  function getPreferences() {
    return porto.storage.get('e2ePreferences');
  }

  function setPreferences(preferences) {
    porto.storage.set('e2ePreferences', preferences);
  }

  exports.getManagementList = getManagementList;
  exports.setManagementList = setManagementList;
  exports.getWatchList = getWatchList;
  exports.setWatchList = setWatchList;
  exports.getHostname = getHostname;
  exports.getBaseName = getBaseName;
  exports.getHost = porto.util.getHost;
  exports.getPreferences = getPreferences;
  exports.setPreferences = setPreferences;

  function migrate08() {
    var prefs = getPreferences();
    if ( (porto.webex || porto.crx) && prefs.migrate08 && prefs.migrate08.done) {
      window.localStorage.removeItem("privatekeys");
      window.localStorage.removeItem("publickeys");
      delete prefs.migrate08;
      setPreferences(prefs);
    }

  }

  exports.migrate08 = migrate08;

});
