'use strict';

var assert = require('assert');
var API = require('./api');
var validator = require('./validator');
var helpers = require('./helpers');
var RippleAPI = require('ripple-lib').RippleAPI;
var Big = require('big.js');

function Wallet(options) {
  if (arguments.length === 0) return this;

  var seed = options.seed;
  var done = options.done;
  var txDone = options.txDone ? options.txDone : function() {};

  try {
    assert(seed, 'seed cannot be empty');
  } catch (err) {
    return doneError(err);
  }

  this.networkName = options.networkName;
  this.txsPerPage = options.txsPerPage || 20;
  this.api = new API();
  this.ripple = new RippleAPI();
  this.balance = '0';
  this.fee = '0';
  this.isActive = false;
  this.historyTxs = [];
  this.hasMoreTxs = false;
  this.sequence = 0;
  this.account = helpers.generateAccount(seed);
  this.addressString = this.account.address;

  this.minReserve = 20;
  this.dustThreshold = 0.000001;

  var that = this;

  Promise.all([
    that.api.accounts.info(that.addressString),
    that.api.common.fee()
  ]).then(function(results) {
    that.balance = results[0].balance;
    that.sequence = results[0].sequence;
    that.isActive = results[0].isActive;
    that.fee = results[1];
    done(null, that);
  }).catch(done).then(function() {
    if (!that.isActive) return txDone(null, that);
    return that.loadTxs(that.addressString).then(function(data) {
      that.historyTxs = data.txs;
      that.hasMoreTxs = data.hasMoreTxs;
      txDone(null, that);
    });
  }).catch(txDone);

  function doneError(err) {
    done(err);
    txDone(err);
  }
}

Wallet.prototype.loadTxs = function(address, start) {
  return this.api.accounts.txs(address, start, this.txsPerPage).then(function(data) {
    data.txs = data.txs.map(function(tx) {
      if (tx.from === address) {
        tx.amount = '-' + tx.amount;
      }
      return tx;
    });
    return data;
  });
};

Wallet.prototype.getDestinationInfo = function(address) {
  return this.api.accounts.info(address);
};

Wallet.prototype.getBalance = function() {
  return this.balance;
};

Wallet.prototype.getNextAddress = function() {
  return this.addressString;
};

Wallet.prototype.createTx = function(to, value, tag, invoiceId, needToActivateAccount) {
  var payment = {
    source: {
      address: this.addressString,
      maxAmount: {
        value: value,
        currency: 'XRP'
      }
    },
    destination: {
      address: to,
      amount: {
        value: value,
        currency: 'XRP'
      }
    }
  };

  if (tag) {
    payment.destination.tag = parseInt(tag);
  }
  if (invoiceId) {
    payment.invoiceID = invoiceId;
  }

  validator.transaction({
    wallet: this,
    payment: payment,
    needToActivateAccount: needToActivateAccount
  });

  return {
    payment: payment,
    address: this.addressString,
    secret: this.account.secret,
    sequence: this.sequence
  };
};

Wallet.prototype.getDefaultFee = function() {
  return this.fee;
};

Wallet.prototype.sendTx = function(tx, done) {
  var that = this;
  that.api.common.maxLedgerVersion().then(function(maxLedgerVersion) {
    return {
      fee: that.fee,
      sequence: tx.sequence,
      maxLedgerVersion: maxLedgerVersion
    };
  }).then(function(instructions) {
    return that.ripple.preparePayment(tx.address, tx.payment, instructions);
  }).then(function(prepared) {
    var signed = that.ripple.sign(prepared.txJSON, tx.secret);
    return that.api.transactions.propagate(signed.signedTransaction).then(function() {
      if (tx.address === that.addressString) {
        that.sequence++;
        that.balance = Big(that.balance).minus(tx.payment.source.maxAmount.value).minus(that.fee).toFixed();
      } else {
        that.balance = Big(that.balance).plus(tx.payment.source.maxAmount.value).minus(that.fee).toFixed();
      }
      done(null);
    }).catch(function(err) {
      if (err.response && err.response.data && /^tec/.test(err.response.data.resultCode)) {
        that.sequence++;
      }
      throw err;
    });
  }).catch(done);
};

Wallet.prototype.getTransactionHistory = function() {
  return this.historyTxs;
};

Wallet.prototype.createPrivateKey = function(secret) {
  validator.secret(secret);
  return secret;
};

Wallet.prototype.createImportTx = function(options) {
  var amount = Big(options.amount).minus(this.getDefaultFee());
  if (amount.lt(0)) {
    throw new Error('Insufficient funds');
  }
  if (!this.isActive && amount.lt(this.minReserve)) {
    throw new Error('Less than minimum reserve');
  }

  var payment = {
    source: {
      address: options.address,
      maxAmount: {
        value: amount.toFixed(),
        currency: 'XRP'
      }
    },
    destination: {
      address: options.to,
      amount: {
        value: amount.toFixed(),
        currency: 'XRP'
      }
    }
  };

  return {
    payment: payment,
    sequence: options.sequence,
    secret: options.secret,
    address: options.address
  };
};

Wallet.prototype.getImportTxOptions = function(secret) {
  if (secret === this.account.secret) return Promise.reject(new Error('Private key equal wallet private key'));
  var that = this;
  var address = helpers.getAddressFromSecret(secret);

  return that.api.accounts.info(address).then(function(info) {
    return {
      amount: helpers.max(Big(info.balance).minus(that.minReserve), Big(0)).toFixed(),
      sequence: info.sequence,
      secret: secret,
      address: address
    };
  });
};

Wallet.prototype.exportPrivateKeys = function() {
  var str = 'address,privatekey\n';
  str += this.addressString + ',' + this.account.secret;
  return str;
};

Wallet.prototype.serialize = function() {
  return JSON.stringify({
    networkName: this.networkName,
    balance: this.getBalance(),
    fee: this.getDefaultFee(),
    historyTxs: this.historyTxs,
    account: this.account,
    sequence: this.sequence,
    minReserve: this.minReserve,
    dustThreshold: this.dustThreshold,
    txsPerPage: this.txsPerPage
  });
};

Wallet.deserialize = function(json) {
  var wallet = new Wallet();
  var deserialized = JSON.parse(json);

  wallet.networkName = deserialized.networkName;
  wallet.api = new API();
  wallet.balance = deserialized.balance;
  wallet.fee = deserialized.fee;
  wallet.historyTxs = deserialized.historyTxs;
  wallet.account = deserialized.account;
  wallet.addressString = wallet.account.address;
  wallet.sequence = deserialized.sequence;
  wallet.minReserve = deserialized.minReserve;
  wallet.dustThreshold = deserialized.dustThreshold;
  wallet.txsPerPage = deserialized.txsPerPage;
  return wallet;
};

module.exports = Wallet;
