'use strict';

define(function (require, exports, module) {

  var sub = require('./sub.controller');
  var uiLog = require('../uiLog');
  var pwdCache = require('../pwdCache');
  var Web3 = require('../web3');
  var CryptoJS = require('../crypto-js');
  var openpgp = require('openpgp');

  function EncryptController(port) {
    sub.SubController.call(this, port);
    this.keyidBuffer = null;
    this.signBuffer = null;
    this.editorControl = null;
    this.recipientsCallback = null;
    this.keyring = require('../keyring');
  }

  EncryptController.prototype = Object.create(sub.SubController.prototype);

  function encryptPassword(password) {
    return CryptoJS.AES.encrypt(password, password).toString();
  }

  function encryptPrivateKey(privateKey, addressPassword) {
    return CryptoJS.AES.encrypt(privateKey, addressPassword).toString();
  }

  function decryptPassword(encryptedPassword, plainPassword) {
    return CryptoJS.AES.decrypt(encryptedPassword, plainPassword).toString(CryptoJS.enc.Utf8);
  }

  function decryptPrivateKey(privateKey, addressPassword) {
    return CryptoJS.AES.decrypt(privateKey, addressPassword).toString(CryptoJS.enc.Utf8);
  }


  EncryptController.prototype.handlePortMessage = function (msg) {
    var that = this;
    var localKeyring = this.keyring.getById(this.porto.LOCAL_KEYRING_ID);
    //console.log('encrypt.controller::' + msg.event);
    //console.log(msg);
    //console.trace();
    var keys = localKeyring.getPrivateKeys();
    switch (msg.event) {
      case 'encrypt-dialog-cancel':
      case 'sign-dialog-cancel':
        // forward event to encrypt frame
        this.ports.eFrame.postMessage(msg);
        break;
      case 'sign-dialog-init':
        var primary = localKeyring.getAttributes().primary_key;
        this.porto.data.load('common/ui/inline/dialogs/templates/sign.html').then(function (content) {
          var port = that.ports.sDialog;
          port.postMessage({event: 'sign-dialog-content', data: content});
          port.postMessage({event: 'signing-key-userids', keys: keys, primary: primary});
        });
        break;
      case 'gw_sign-dialog-init':
        var goodwillData = JSON.parse(window.localStorage.getItem("goodwill"));
        this.porto.data.load('common/ui/inline/dialogs/templates/gwSign.html').then(function (content) {
          var port = that.ports.gwsDialog;
          port.postMessage({event: 'gw-sign-dialog-content', data: content});
          port.postMessage({event: 'gw-signing-data', gwdata: goodwillData});
        });
        break;
      case 'get-signing-keys':
        that.ports.eFrame.postMessage({event: 'filter-relevant-key', keys: keys});
        break;
      case 'send-armored-pub':
        // TODO called from signDialog
        var armored = localKeyring.getArmoredKeys(msg.keyIds, {pub: true});

        var privKeys = localKeyring.getPrivateKeys();
        var fingerprintArr = [];
        for (var inx = 0; inx < msg.keyIds.length; inx++) {
          var keyId = msg.keyIds[inx];
          for (var jnx = 0; jnx < privKeys.length; jnx++) {
            var privKey = privKeys[jnx];
            if (privKey.id === keyId.toUpperCase()) {
              fingerprintArr.push(privKey.fingerprint);
            }
          }
        }
        that.ports.eFrame.postMessage({
          event: 'get-armored-pub',
          armor: armored,
          fingerprint: fingerprintArr,
          keyName: msg.keyName
        });
        break;
      case 'bp-show-keys-popup-alice':
        that.ports.eFrame.postMessage({event: 'bp-show-keys-popup-bob'});
        break;
      case 'encrypt-dialog-init':
        // send content
        this.porto.data.load('common/ui/inline/dialogs/templates/encrypt.html').then(function (content) {
          //console.log('content rendered', content);
          that.ports.eDialog.postMessage({event: 'encrypt-dialog-content', data: content});
          // get potential recipients from eFrame
          // if editor is active get recipients from parent eFrame
          that.ports.eFrame.postMessage({event: 'recipient-proposal'});
        });
        break;
      case 'eframe-recipient-proposal':
        var emails = this.porto.util.sortAndDeDup(msg.data);
        var userKeys = localKeyring.getKeyUserIDs(emails);
        var primary;
        if (this.prefs.data().general.auto_add_primary) {
          primary = localKeyring.getAttributes().primary_key;
          primary = primary && primary.toLowerCase();
        }
        if (this.recipientsCallback) {
          this.recipientsCallback({keys: userKeys, primary: primary});
          this.recipientsCallback = null;
        } else {
          this.ports.eDialog.postMessage({event: 'public-key-userids', keys: userKeys, primary: primary});
        }
        break;
      case 'encrypt-dialog-ok':
        // add recipients to buffer
        this.keyidBuffer = msg.recipient;
        // get email text from eFrame
        this.ports.eFrame.postMessage({event: 'email-text', type: msg.type, action: 'encrypt'});
        break;
      case 'sign-dialog-ok':
        this.signBuffer = {};
        var key = this.keyring.getById(this.porto.LOCAL_KEYRING_ID).getKeyForSigning(msg.signKeyId);
        // add key in buffer
        this.signBuffer.key = key.signKey;
        this.signBuffer.keyid = msg.signKeyId;
        this.signBuffer.userid = key.userId;
        this.signBuffer.reason = 'PWD_DIALOG_REASON_SIGN';
        this.signBuffer.keyringId = this.porto.LOCAL_KEYRING_ID;
        this.pwdControl = sub.factory.get('pwdDialog');
        this.pwdControl.unlockKey(this.signBuffer)
          .then(function () {
            that.ports.eFrame.postMessage({
              event: 'email-text',
              type: msg.type,
              action: 'sign',
              fingerprint: msg.fingerprint
            });
          })
          .catch(function (err) {
            if (err.code = 'PWD_DIALOG_CANCEL') {
              that.ports.eFrame.postMessage({event: 'sign-dialog-cancel'});
              return;
            }
            if (err) {
              // TODO: propagate error to sign dialog
            }
          });

        break;
      case 'gw-sign-dialog-ok':
        that.ports.eFrame.postMessage({event: 'gw-signed-message', message: msg});
        break;
      case 'eframe-email-text':
        if (msg.action === 'encrypt') {
          // TODO fix error while encrypting message, instead of passing three parameters to
          // pgpMode.encryptMessage wrap it into one object with relevant keys
          this.model.encryptMessage(msg.data, this.porto.LOCAL_KEYRING_ID, this.keyidBuffer)
            .then(function (msg) {
              that.ports.eFrame.postMessage({event: 'encrypted-message', message: msg});
            })
            .catch(function (error) {
              console.log('model.encryptMessage() error', error);
            });
        } else if (msg.action === 'sign') {
          var fingerprint = msg.fingerprint;
          this.model.signMessage(msg.data, this.signBuffer.key)
            .then(function (msg) {
              that.ports.eFrame.postMessage({
                event: 'signed-message',
                message: msg,
                fingerprint: fingerprint
              });
            })
            .catch(function (error) {
              console.log('model.signMessage() error', error);
            });
        } else {
          throw new Error('Unknown eframe action:', msg.action);
        }

        var goodWillAddresses = JSON.parse(window.localStorage.getItem("goodwill"));

        for (var i = 0; i < goodWillAddresses.length; i++) {
          if (goodWillAddresses[i].id === this.signBuffer.key.primaryKey.fingerprint) {
            var prKey = decryptPrivateKey(goodWillAddresses[i].private_key, this.signBuffer.password);

            var web3 = new Web3();
            var message = web3.eth.accounts.sign("Hello", prKey);

            that.ports.eFrame.postMessage({
              event: 'gw-signed-message',
              message: JSON.stringify ({signature: message.signature,   messageHash: message.messageHash, address: goodWillAddresses[i].address})
            });
          }
        }

        break;
      case 'eframe-textarea-element':
        var defaultEncoding = {};
        if (msg.isTextElement || this.prefs.data().general.editor_type == this.porto.PLAIN_TEXT) {
          defaultEncoding.type = 'text';
          defaultEncoding.editable = false;
        } else {
          defaultEncoding.type = 'html';
          defaultEncoding.editable = true;
        }
        // if eDialog is active in inline mode
        this.ports.eDialog && this.ports.eDialog.postMessage({event: 'encoding-defaults', defaults: defaultEncoding});
        break;
      case 'eframe-display-editor':
        if (this.porto.windows.modalActive) {
          // modal dialog already open
          // TODO show error, fix modalActive on FF
        } else {
          this.editorControl = sub.factory.get('editor');
          this.editorControl.encrypt({
            initText: msg.text,
            getRecipients: this.getRecipients.bind(this)
          }, function (err, armored) {
            if (!err) {
              // sanitize if content from plain text, rich text already sanitized by editor
              if (that.prefs.data().general.editor_type == that.porto.PLAIN_TEXT) {
                that.porto.util.parseHTML(armored, function (parsed) {
                  that.ports.eFrame.postMessage({event: 'set-editor-output', text: parsed});
                });
              } else {
                that.ports.eFrame.postMessage({event: 'set-editor-output', text: armored});
              }
            } else {
              // TODO: error handling
            }
          });
        }
        break;
      case 'editor-user-input':
        uiLog.push(msg.source, msg.type);
        break;
      default:
        console.log('unknown event', msg);
    }
  };

  EncryptController.prototype.getRecipients = function (callback) {
    if (this.recipientsCallback) {
      throw new Error('Waiting for recipients result.');
    }
    this.ports.eFrame.postMessage({event: 'recipient-proposal'});
    this.recipientsCallback = callback;
  };

  exports.EncryptController = EncryptController;

});
