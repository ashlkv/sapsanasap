var Storage = require('./storage');

var request = require('request-promise');
var Promise = require('bluebird');

var debug = require('debug')('url');

const shortenerUrl = 'https://www.googleapis.com/urlshortener/v1/url';
const collectioName = 'urls';

/**
 * Shortens an url
 * @param {String} longUrl
 * @returns {Promise}
 */
var shorten = function(longUrl) {
    return getCachedShortUrl(longUrl)
        .then(function(shortUrl) {
            var promise;
            if (!shortUrl) {
                var parameters = {
                    key: process.env.GOOGLE_API_KEY
                };
                var requestBody = {
                    longUrl: longUrl
                };

                // Using url shortener because when a link in Telegram gets clicked, the '|' characters in rzd url are url-encoded into %7C, which breaks the url.
                // There is no way to avoid the '|' character usage.
                promise = request({
                    method: 'POST',
                    url: shortenerUrl,
                    qs: parameters,
                    body: requestBody,
                    resolveWithFullResponse: true,
                    json: true
                })
                .then(function(response) {
                    var body = response.body;
                    return body.id;
                })
                .then(function(shortUrl) {
                    return Promise.all([shortUrl, cacheShortUrl(shortUrl, longUrl)]);
                })
                .then(function(result) {
                    return result[0];
                });

            } else {
                promise = Promise.resolve(shortUrl);
            }
            return promise;
        })
        .catch(function() {
            throw new Error('Unable to shorten the url');
        });
};


/**
 * Returns a shortened url from cache
 * @param {String} longUrl
 * @returns {Promise}
 */
var getCachedShortUrl = function(longUrl) {
    return Storage
        .find(collectioName, {longUrl: longUrl})
        .then(function(results) {
            return results && results.length && results[0].shortUrl;
        });
};

/**
 * Caches shortened url
 * @param {String} shortUrl
 * @param {String} longUrl
 * @returns {Promise}
 */
var cacheShortUrl = function(shortUrl, longUrl) {
    var entry = {
        shortUrl: shortUrl,
        longUrl: longUrl
    };

    return Storage.insert(collectioName, entry);
};

module.exports = {
    shorten: shorten
};