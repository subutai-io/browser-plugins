'use strict';

define(function(require, exports, module) {

  var porto = require('../porto-lib').porto;
  var openpgp = require('openpgp');
  var Web3 = require('./web3');
  var goog = require('./closure-library/closure/goog/emailaddress').goog;
  var prefs = require('./prefs');
  var l10n = porto.l10n.get;
  var keyringSync = require('./keyringSync');
  var keyringAttr = null;
  var keyringMap = new Map();

  function init() {
    keyringAttr = getAllKeyringAttr();
    if (keyringAttr && keyringAttr[porto.LOCAL_KEYRING_ID]) {
      for (var keyringId in keyringAttr) {
        if (keyringAttr.hasOwnProperty(keyringId)) {
          keyringMap.set(keyringId, new Keyring(keyringId));
        }
      }
    } else {
      createKeyring(porto.LOCAL_KEYRING_ID);
      // migrate primary_key attribute
      if (prefs.data().general.primary_key) {
        setKeyringAttr(porto.LOCAL_KEYRING_ID, {primary_key: prefs.data().general.primary_key});
      }
    }
  }

  function createKeyring(keyringId, options) {
    if (!keyringAttr) {
      keyringAttr = {};
    }
    if (keyringAttr[keyringId]) {
      var error = new Error('Keyring for id ' + keyringId + ' already exists.');
      error.code = 'KEYRING_ALREADY_EXISTS';
      throw error;
    }
    keyringAttr[keyringId] = {};
    var keyRng = new Keyring(keyringId);
    keyringMap.set(keyringId, keyRng);
    setKeyringAttr(keyringId, {} || options);
    return keyRng;
  }

  function deleteKeyring(keyringId) {
    if (!keyringAttr[keyringId]) {
      var error = new Error('Keyring for id ' + keyringId + ' does not exist.');
      error.code = 'NO_KEYRING_FOR_ID';
      throw error;
    }
    var keyRng = keyringMap.get(keyringId);
    keyRng.keyring.clear();
    keyRng.keyring.store();
    keyRng.keyring.storeHandler.storage.removeItem(keyRng.keyring.storeHandler.publicKeysItem);
    keyRng.keyring.storeHandler.storage.removeItem(keyRng.keyring.storeHandler.privateKeysItem);
    keyringMap.delete(keyringId);
    delete keyringAttr[keyringId];
    porto.storage.set('e2eKeyringAttr', keyringAttr);
  }

  function getById(keyringId) {
    var keyring = keyringMap.get(keyringId);
    if (keyring) {
      return keyring;
    } else {
      var error = new Error('No keyring found for this identifier.');
      error.code = 'NO_KEYRING_FOR_ID';
      throw error;
    }
  }

  function getAllKeyringAttr() {
    return porto.storage.get('e2eKeyringAttr');
  }

  function setKeyringAttr(keyringId, attr) {
    if (!keyringAttr[keyringId]) {
      throw new Error('Keyring does not exist for id: ' + keyringId);
    }
    porto.util.extend(keyringAttr[keyringId], attr);
    porto.storage.set('e2eKeyringAttr', keyringAttr);
  }

  function getKeyringAttr(keyringId, attr) {
    if (!keyringAttr[keyringId]) {
      throw new Error('Keyring does not exist for id: ' + keyringId);
    }
    return keyringAttr[keyringId][attr];
  }

  function getUserId(key, validityCheck) {
    validityCheck = typeof validityCheck === 'undefined' ? true : false;
    var primaryUser = key.getPrimaryUser();
    if (primaryUser) {
      return primaryUser.user.userId.userid;
    } else {
      if (!validityCheck) {
        // take first available user ID
        for (var i = 0; i < key.users.length; i++) {
          if (key.users[i].userId) {
            return key.users[i].userId.userid;
          }
        }
      }
      return l10n('keygrid_invalid_userid');
    }
  }


  Keyring.prototype.readArmoredKey = function (armored) {
    var parsedKey = openpgp.key.readArmored(armored);
    return parsedKey;
  };

  Keyring.prototype.getGWAccount = function (privateKey) {
    var web3 = new Web3();
    var account = web3.eth.accounts.privateKeyToAccount(privateKey);
    return account;
  };

  function readKey(armored) {
    var parsedKey = openpgp.key.readArmored(armored);
    if (parsedKey.err) {
      return parsedKey;
    }
    parsedKey.keys = mapKeys(parsedKey.keys);
    return parsedKey;
  }

  function cloneKey(key) {
    var binary = key.toPacketlist().write();
    var packetList = new openpgp.packet.List();
    packetList.read(binary);
    return new openpgp.key.Key(packetList);
  }

  exports.init = init;
  exports.createKeyring = createKeyring;
  exports.deleteKeyring = deleteKeyring;
  exports.getAllKeyringAttr = getAllKeyringAttr;
  exports.setKeyringAttr = setKeyringAttr;
  exports.getKeyringAttr = getKeyringAttr;
  exports.getById = getById;
  exports.getUserId = getUserId;
  exports.readKey = readKey;
  exports.mapKeys = mapKeys;
  exports.cloneKey = cloneKey;

  function Keyring(keyringId) {
    this.id = keyringId;
    var localstore = null;
    if (this.id !== porto.LOCAL_KEYRING_ID) {
      localstore = new openpgp.Keyring.localstore(this.id);
    }
    this.keyring = new openpgp.Keyring(localstore);
    this.sync = new keyringSync.KeyringSync(this.id);
  }

  Keyring.prototype.getKeys = function() {
    // map keys to UI format
    var keys = this.getPublicKeys().concat(this.getPrivateKeys());
    // sort by key type and name
    keys = keys.sort(function(a, b) {
      var compType = a.type.localeCompare(b.type);
      if (compType === 0) {
        return a.name.localeCompare(b.name);
      } else {
        return compType;
      }
    });
    return keys;
  };

  Keyring.prototype.getPublicKeys = function() {
    return mapKeys(this.keyring.publicKeys.keys);
  };

  Keyring.prototype.getPrivateKeys = function() {
    return mapKeys(this.keyring.privateKeys.keys);
  };

  function mapKeys(keys) {
    var result = [];
    keys.forEach(function(key) {
      var uiKey = {};
      if (key.isPublic()) {
        uiKey.type = 'public';
      } else {
        uiKey.type = 'private';
      }
      try {
        uiKey.validity = key.verifyPrimaryKey() === openpgp.enums.keyStatus.valid;
      } catch (e) {
        uiKey.validity = false;
      }
      // fingerprint used as UID
      uiKey.guid = key.primaryKey.getFingerprint();
      uiKey.id = key.primaryKey.getKeyId().toHex().toUpperCase();
      uiKey.fingerprint = uiKey.guid.toUpperCase();
      // primary user
      try {
        uiKey.userId = getUserId(key, false);
        var address = goog.format.EmailAddress.parse(uiKey.userId);
        uiKey.name = address.getName();
        uiKey.email = address.getAddress();
        uiKey.exDate = key.getExpirationTime();
        if (uiKey.exDate) {
          uiKey.exDate = uiKey.exDate.toISOString();
        } else {
          uiKey.exDate = false;
        }
      } catch (e) {
        uiKey.name = uiKey.name || 'NO USERID FOUND';
        uiKey.email = uiKey.email || 'UNKNOWN';
        uiKey.exDate = uiKey.exDate || 'UNKNOWN';
      }
      uiKey.crDate = key.primaryKey.created.toISOString();
      uiKey.algorithm = getAlgorithmString(key.primaryKey.algorithm);
      uiKey.bitLength = key.primaryKey.getBitSize();
      result.push(uiKey);
    });
    return result;
  }

  function getAlgorithmString(keyType) {
    var result = '';
    switch (keyType) {
    case 'rsa_encrypt_sign':
      result = "RSA (Encrypt or Sign)";
      break;
    case 'rsa_encrypt':
      result = "RSA Encrypt-Only";
      break;
    case 'rsa_sign':
      result = "RSA Sign-Only";
      break;
    case 'elgamal':
      result = "Elgamal (Encrypt-Only)";
      break;
    case 'dsa':
      result = "DSA (Digital Signature Algorithm)";
      break;
    default:
      result = "UNKNOWN";
    }
    return result;
  }

  Keyring.prototype.getKeyDetails = function(guid) {
    var details = {};
    var keys = this.keyring.getKeysForId(guid);
    if (keys) {
      var key = keys[0];
      // subkeys
      mapSubKeys(key.subKeys, details);
      // users
      mapUsers(key.users, details, this.keyring, key.primaryKey);
      return details;
    } else {
      throw new Error('Key with this fingerprint not found: ', guid);
    }
  };

  function mapSubKeys(subkeys, toKey) {
    toKey.subkeys = [];
    subkeys && subkeys.forEach(function(subkey) {
      try {
        var skey = {};
        skey.crDate = subkey.subKey.created.toISOString();
        skey.exDate = subkey.getExpirationTime();
        if (skey.exDate) {
          skey.exDate = skey.exDate.toISOString();
        } else {
          skey.exDate = false;
        }
        skey.id = subkey.subKey.getKeyId().toHex().toUpperCase();
        skey.algorithm = getAlgorithmString(subkey.subKey.algorithm);
        skey.bitLength = subkey.subKey.getBitSize();
        skey.fingerprint = subkey.subKey.getFingerprint().toUpperCase();
        toKey.subkeys.push(skey);
      } catch (e) {
        console.log('Exception in mapSubKeys', e);
      }
    });
  }

  function mapUsers(users, toKey, keyring, primaryKey) {
    toKey.users = [];
    users && users.forEach(function(user) {
      try {
        var uiUser = {};
        uiUser.userID = user.userId.userid;
        uiUser.signatures = [];
        user.selfCertifications && user.selfCertifications.forEach(function(selfCert) {
          if (!user.isValidSelfCertificate(primaryKey, selfCert)) {
            return;
          }
          var sig = {};
          sig.signer = user.userId.userid;
          sig.id = selfCert.issuerKeyId.toHex().toUpperCase();
          sig.crDate = selfCert.created.toISOString();
          uiUser.signatures.push(sig);
        });
        user.otherCertifications && user.otherCertifications.forEach(function(otherCert) {
          var sig = {};
          var keyidHex = otherCert.issuerKeyId.toHex();
          var issuerKeys = keyring.getKeysForId(keyidHex);
          if (issuerKeys) {
            var signingKeyPacket = issuerKeys[0].getKeyPacket([otherCert.issuerKeyId]);
            if (signingKeyPacket && (otherCert.verified || otherCert.verify(signingKeyPacket, {userid: user.userId, key: primaryKey}))) {
              sig.signer = getUserId(issuerKeys[0]);
            } else {
              // invalid signature
              return;
            }
          } else {
            sig.signer = l10n("keygrid_signer_unknown");
          }
          sig.id = otherCert.issuerKeyId.toHex().toUpperCase();
          sig.crDate = otherCert.created.toISOString();
          uiUser.signatures.push(sig);
        });
        toKey.users.push(uiUser);
      } catch (e) {
        console.log('Exception in mapUsers', e);
      }
    });
  }

  Keyring.prototype.getKeyUserIDs = function(proposal) {
    var result = [];
    this.keyring.getAllKeys().forEach(function(key) {
      if (key.verifyPrimaryKey() === openpgp.enums.keyStatus.valid) {
        var user = {};
        mapKeyUserIds(key, user, proposal);
        result.push(user);
      }
    });
    result = result.sort(function(a, b) {
      return a.userid.localeCompare(b.userid);
    });
    return result;
  };

  function mapKeyUserIds(key, user, proposal) {
    user.keyid = key.primaryKey.getKeyId().toHex();
    try {
      user.userid = getUserId(key);
      var email = goog.format.EmailAddress.parse(user.userid).getAddress();
      user.proposal = proposal.some(function(element) {
        return email === element;
      });
    } catch (e) {
      user.userid = l10n('keygrid_invalid_userid');
    }
  }

  Keyring.prototype.getKeyIdByAddress = function(emailAddr, options) {
    var that = this;
    var addressMap = this.getKeyByAddress(emailAddr, options);
    for (var address in addressMap) {
      addressMap[address] = addressMap[address] && addressMap[address].map(function(key) {
        if (options.fingerprint) {
          return key.primaryKey.getFingerprint();
        }
        return key.primaryKey.getKeyId().toHex();
      });
    }
    return addressMap;
  };

  Keyring.prototype.getKeyByAddress = function(emailAddr, options) {
    var that = this;
    if (typeof options.pub === 'undefined') {
      options.pub = true;
    }
    if (typeof options.priv === 'undefined') {
      options.priv = true;
    }
    var result = Object.create(null);
    emailAddr.forEach(function(emailAddr) {
      result[emailAddr] = [];
      if (options.pub) {
        result[emailAddr] = result[emailAddr].concat(that.keyring.publicKeys.getForAddress(emailAddr));
      }
      if (options.priv) {
        result[emailAddr] = result[emailAddr].concat(that.keyring.privateKeys.getForAddress(emailAddr));
      }
      result[emailAddr] = result[emailAddr].filter(function(key) {
        if (options.validity && (
            key.verifyPrimaryKey() !== openpgp.enums.keyStatus.valid ||
            key.getEncryptionKeyPacket() === null)) {
          return;
        }
        return true;
      });
      if (!result[emailAddr].length) {
        result[emailAddr] = false;
      } else if (options.sort) {
        // sort by key creation date and primary key status
        var primaryKeyId = that.getAttributes().primary_key;
        result[emailAddr].sort(function(a, b) {
          if (primaryKeyId) {
            primaryKeyId = primaryKeyId.toLowerCase();
            if (primaryKeyId === a.primaryKey.getKeyId().toHex()) {
              return -1;
            }
            if (primaryKeyId === b.primaryKey.getKeyId().toHex()) {
              return 1;
            }
          }
          return b.primaryKey.created - a.primaryKey.created;
        });
      }
    });
    return result;
  };

  Keyring.prototype.getArmoredKeys = function(keyids, options) {
    var that = this;
    var result = [];
    var keys = null;
    if (options.all) {
      keys = this.keyring.getAllKeys();
    } else {
      keys = keyids.map(function(keyid) {
        return that.keyring.getKeysForId(keyid)[0];
      });
    }
    keys.forEach(function(key) {
      var armored = {};
      if (options.pub) {
        armored.armoredPublic = key.toPublic().armor();
      }
      if (options.priv && key.isPrivate()) {
        armored.armoredPrivate = key.armor();
      }
      result.push(armored);
    });
    return result;
  };

  Keyring.prototype.hasPrimaryKey = function() {
    return this.getAttributes().primary_key ? true : false;
  };

  Keyring.prototype.getPrimaryKey = function() {
    var primaryKey;
    var primaryKeyid = this.getAttributes().primary_key;
    if (!primaryKeyid) {
      // get newest private key
      this.keyring.privateKeys.keys.forEach(function(key) {
        if (!primaryKey || primaryKey.primaryKey.created < key.primaryKey.created) {
          primaryKey = key;
        }
      });
    } else {
      primaryKey = this.keyring.privateKeys.getForId(primaryKeyid.toLowerCase());
    }
    if (!primaryKey) {
      return null;
    }
    return {
      key: primaryKey,
      keyid: primaryKey.primaryKey.getKeyId().toHex(),
      userid: getUserId(primaryKey)
    };
  };

  Keyring.prototype.importKeys = function(armoredKeys) {
    var that = this;
    var result = [];
    // sort, public keys first
    armoredKeys = armoredKeys.sort(function(a, b) {
      return b.type.localeCompare(a.type);
    });
    // import
    armoredKeys.forEach(function(key) {
      try {
        if (key.type === 'public') {
          result = result.concat(that.importPublicKey(key.armored, that.keyring));
        } else if (key.type === 'private') {
          result = result.concat(that.importPrivateKey(key.armored, that.keyring));
        }
      } catch (e) {
        result.push({
          type: 'error',
          message: l10n('key_import_unable', [e])
        });
      }
    });
    // store if import succeeded
    if (result.some(function(message) { return message.type === 'success';})) {
      this.keyring.store();
      this.sync.commit();
      // by no primary key in the keyring set the first found private keys as primary for the keyring
      if (!that.hasPrimaryKey() && that.keyring.privateKeys.keys.length > 0) {
        setKeyringAttr(that.id, {primary_key: that.keyring.privateKeys.keys[0].primaryKey.keyid.toHex().toUpperCase()});
      }
    }
    return result;
  };

  Keyring.prototype.importPublicKey = function(armored) {
    var that = this;
    var result = [];
    var imported = openpgp.key.readArmored(armored);
    if (imported.err) {
      imported.err.forEach(function(error) {
        result.push({
          type: 'error',
          message: l10n('key_import_public_read', [error.message])
        });
      });
    }
    imported.keys.forEach(function(pubKey) {
      // check for existing keys
      checkKeyId(pubKey, that.keyring);
      var fingerprint = pubKey.primaryKey.getFingerprint();
      var key = that.keyring.getKeysForId(fingerprint);
      var keyid = pubKey.primaryKey.getKeyId().toHex().toUpperCase();
      if (key) {
        key = key[0];
        key.update(pubKey);
        result.push({
          type: 'success',
          message: l10n('key_import_public_update', [keyid, getUserId(pubKey)])
        });
        that.sync.add(fingerprint, keyringSync.UPDATE);
      } else {
        that.keyring.publicKeys.push(pubKey);
        result.push({
          type: 'success',
          message: l10n('key_import_public_success', [keyid, getUserId(pubKey)])
        });
        that.sync.add(fingerprint, keyringSync.INSERT);
      }
    });
    return result;
  };

  Keyring.prototype.importPrivateKey = function(armored) {
    var that = this;
    var result = [];
    var imported = openpgp.key.readArmored(armored);
    if (imported.err) {
      imported.err.forEach(function(error) {
        result.push({
          type: 'error',
          message: l10n('key_import_private_read', [error.message])
        });
      });
    }
    imported.keys.forEach(function(privKey) {
      // check for existing keys
      checkKeyId(privKey, that.keyring);
      var fingerprint = privKey.primaryKey.getFingerprint();
      var key = that.keyring.getKeysForId(fingerprint);
      var keyid = privKey.primaryKey.getKeyId().toHex().toUpperCase();
      if (key) {
        key = key[0];
        if (key.isPublic()) {
          privKey.update(key);
          that.keyring.publicKeys.removeForId(fingerprint);
          that.keyring.privateKeys.push(privKey);
          result.push({
            type: 'success',
            message: l10n('key_import_private_exists', [keyid, getUserId(privKey)])
          });
          that.sync.add(fingerprint, keyringSync.UPDATE);
        } else {
          key.update(privKey);
          result.push({
            type: 'success',
            message: l10n('key_import_private_update', [keyid, getUserId(privKey)])
          });
          that.sync.add(fingerprint, keyringSync.UPDATE);
        }
      } else {
        that.keyring.privateKeys.push(privKey);
        result.push({
          type: 'success',
          message: l10n('key_import_private_success', [keyid, getUserId(privKey)])
        });
        that.sync.add(fingerprint, keyringSync.INSERT);
      }
    });
    return result;
  };

  function checkKeyId(sourceKey, keyring) {
    var primKeyId = sourceKey.primaryKey.getKeyId();
    var keys = keyring.getKeysForId(primKeyId.toHex(), true);
    if (keys) {
      keys.forEach(function(key) {
        if (!key.primaryKey.getKeyId().equals(primKeyId)) {
          throw new Error('Primary keyId equals existing sub keyId.');
        }
      });
    }
    sourceKey.getSubkeyPackets().forEach(function(subKey) {
      var subKeyId = subKey.getKeyId();
      var keys = keyring.getKeysForId(subKeyId.toHex(), true);
      if (keys) {
        keys.forEach(function(key) {
          if (key.primaryKey.getKeyId().equals(subKeyId)) {
            throw new Error('Sub keyId equals existing primary keyId.');
          }
          if (!key.primaryKey.getKeyId().equals(primKeyId)) {
            throw new Error('Sub keyId equals existing sub keyId in key with different primary keyId.');
          }
        });
      }
    });
  }

  Keyring.prototype.removeKey = function(guid, type) {
    var removedKey;
    var removedKeyfingerprint;
    if (type === 'public') {
      removedKey = this.keyring.publicKeys.removeForId(guid);
    } else if (type === 'private') {
      removedKey = this.keyring.privateKeys.removeForId(guid);
    }
    if (!removedKey) {
      return;
    }
    if (type === 'private') {
      var primaryKey = this.getAttributes().primary_key;

      removedKeyfingerprint = removedKey.primaryKey.fingerprint;

      // Remove the key from the keyring attributes if primary
      if (primaryKey && primaryKey.toLowerCase() === removedKey.primaryKey.keyid.toHex()) {
        setKeyringAttr(this.id, {primary_key: ''});
      }
    }
    this.sync.add(removedKey.primaryKey.getFingerprint(), keyringSync.DELETE);
    this.keyring.store();
    this.sync.commit();

    var goodWillAddresses = JSON.parse(window.localStorage.getItem("goodwill"));
    var goodWillAddressesNew = [];
    for (var i in goodWillAddresses)
    {
      if (goodWillAddresses[i].id !== removedKeyfingerprint)
      {
         goodWillAddressesNew.push(goodWillAddresses[i]);
      }
    }

    window.localStorage.setItem('goodwill', JSON.stringify(goodWillAddressesNew));

  };

  Keyring.prototype.generateKey = function(options, callback) {
    var that = this;
    if (!Array.isArray(options.userIds) || options.userIds.length === 0) {
      callback({error: "User ids aren't supplied."});
      return;
    }
    options.userIds = options.userIds.map(function(userId) {
      return (new goog.format.EmailAddress(userId.email, userId.fullName)).toString();
    });
    openpgp.generateKey({numBits: parseInt(options.numBits), userIds: options.userIds, passphrase: options.passphrase}).then(function(data) {
      if (data) {
        that.keyring.privateKeys.push(data.key);
        that.sync.add(data.key.primaryKey.getFingerprint(), keyringSync.INSERT);
        that.keyring.store();
        that.sync.commit();
        // by no primary key in the keyring set the generated key as primary
        if (!that.hasPrimaryKey()) {
          setKeyringAttr(that.id, {primary_key: data.key.primaryKey.keyid.toHex().toUpperCase()});
        }
      }
      callback(null, data);
    }, callback);
  };

  Keyring.prototype.getKeyForSigning = function(keyIdHex) {
    var key = this.keyring.privateKeys.getForId(keyIdHex);
    var userId = getUserId(key);
    return {
      signKey: key,
      userId : userId
    };
  };

  Keyring.prototype.getAttributes = function() {
    return keyringAttr[this.id];
  };
});
