var _ = require('lodash');

var Storage = require('./storage');

/**
 * Get settings value
 * @param {String} key
 * @returns {Promise}
 */
var getValue = function(key) {
    return Storage
        // Get previous collector launch time
        .find(Storage.collectionName.settings)
        .then(function(result) {
            var settings = result && result.length ? result[0] : {};
            return settings[key];
        });
};

/**
 * Set settings value
 * @param {String} key
 * @param {*} value
 * @returns {Promise}
 */
var setValue = function(key, value) {
    return Storage
        // Get previous collector launch time
        .find(Storage.collectionName.settings)
        .then(function(result) {
            var settings = result && result.length ? result[0] : {};
            if (_.isObject(key)) {
                settings = _.extend(settings, key);
            } else {
                settings[key] = value;
            }
            return Storage
                .drop(Storage.collectionName.settings)
                .then(function() {
                    Storage.insert(Storage.collectionName.settings, [settings]);
                });
        });
};

module.exports = {
    getValue: getValue,
    setValue: setValue
};
