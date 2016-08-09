const Promise = require('bluebird');
const debug = require('debug')('history');
const moment = require('moment');

const Storage = require('./storage');

const collectionName = 'history';

/**
 * Stores last chat options for each chat
 * @param {Object} data
 * @param {Number} chatId
 * @returns {Promise}
 */
var save = function(data, chatId) {
    return Storage
        .remove(collectionName, {chatId: chatId})
        .then(function() {
            return Storage.insert(collectionName, {
                data: data,
                date: moment().toDate(),
                chatId: chatId
            });
        });
};

var get = function(chatId) {
    return Storage
        .find(collectionName, {chatId: chatId})
        .then(function(entries) {
            return entries.length ? entries[0].data : {};
        });
};

module.exports = {
    save: save,
    get: get
};