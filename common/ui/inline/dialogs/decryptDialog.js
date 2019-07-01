'use strict';

var porto = porto || null;

(function() {
  var id, name, port, l10n;

  function init() {
    if (document.body.dataset.porto) {
      return;
    }
    document.body.dataset.porto = true;
    // open port to background page
    var qs = jQuery.parseQuerystring();
    id = qs.id;
    name = 'eDialog-' + id;
    port = porto.extension.connect({name: name});
    port.onMessage.addListener(messageListener);
    porto.l10n.getMessages([
      'encrypt_dialog_no_recipient',
      'encrypt_dialog_add',
      'decrypt_dialog_header',
      'keygrid_delete',
      'form_cancel',
      'form_ok'
    ], function(result) {
      port.postMessage({event: 'decrypt-dialog-init', sender: name});
      l10n = result;
    });
  }

  function load(content) {
    $('body').html(content);
    porto.l10n.localizeHTML(l10n);
    $('#okBtn').click(onOk);
    $('#cancelBtn').click(onCancel);
    $('#addBtn').click(onAdd);
    $('#deleteBtn').click(onDelete);
    $('#keyDialog').fadeIn('fast');
    // align width
    $.setEqualWidth($('#okBtn'), $('#cancelBtn'));
    $.setEqualWidth($('#addBtn'), $('#deleteBtn'));
  }

  function onOk() {
    $('body').addClass('busy');
    var $keySelect = $('#keySelect');
    var selectedKey = $keySelect.find(':selected');
    port.postMessage({
      event: 'decrypt-dialog-ok',
      sender: name,
      signKeyId: $keySelect.val(),
      fingerprint: selectedKey.data('fingerprint'),
      type: 'text'
    });
    return false;
  }

  function onCancel() {
    logUserInput('security_log_dialog_cancel');
    port.postMessage({event: 'encrypt-dialog-cancel', sender: name});
    return false;
  }

  function onAdd() {
    // remove possible error
    if ($('#keyList').hasClass('alert-error')) {
      $('#keyList').removeClass('alert-error')
                   .empty();
    }
    var selected = $('#keySelect option:selected');
    // add selection to key list
    $('<option/>').val(selected.val()).text(selected.text()).appendTo($('#keyList'));
    // find next proposal
    var option = selected.next();
    while (option.length !== 0) {
      if (option.data('proposal')) {
        option.prop('selected', true);
        break;
      }
      option = option.next();
    }
    selected.prop('selected', false);
    if (option.length === 0) {
      // no further proposal found, get back to next of selected
      option = selected.next();
      if (option.length === 0) {
        // jump back to first element
        selected.siblings().first().prop('selected', true);
      }
      else {
        // select next non-proposal element
        option.prop('selected', true);
      }
    }
  }

  function onDelete() {
    $('#keyList option:selected').remove();
  }

  /**
   * send log entry for the extension
   * @param {string} type
   */
  function logUserInput(type) {
    port.postMessage({
      event: 'editor-user-input',
      sender: name,
      source: 'security_log_encrypt_dialog',
      type: type
    });
  }

  function messageListener(msg) {
    switch (msg.event) {
      case 'encrypt-dialog-content':
        load(msg.data);
        break;
      case 'decrypt-failed':
        $('body').removeClass('busy');
        alert('Cannot decrypt with this key.');
        console.log('Cannot decrypt with this key: '+JSON.stringify(msg.data));
        break;
      case 'public-key-userids':
        var keySelect = $('#keySelect');
        var firstProposal = true;
        msg.keys.forEach(function(key) {
          var option = $('<option/>').val(key.keyid).text(key.userid);
          if (key.keyid === msg.primary) {
            $('#keyList').append(option.clone());
            key.proposal = false;
          }
          if (key.proposal) {
            option.data('proposal', key.proposal);
            if (firstProposal) {
              // set the first proposal as selected
              option.prop('selected', true);
              firstProposal = false;
            }
          }
          option.appendTo(keySelect);
        });
        break;
      case 'encoding-defaults':
        if (msg.defaults.type === 'text') {
          $('#encodeText').prop('checked', true);
        }
        else {
          $('#encodeHTML').prop('checked', true);
        }
        if (!msg.defaults.editable) {
          $('input[name="encodeRadios"]').prop('disabled', true);
        }
        $('#encoding').show();
        break;
      default:
        console.log('unknown event');
    }
  }

  $(document).ready(init);

}());
