var request = require('request');
var q = require('q');

var debug = require('debug')('utilities');

const shortenerUrl = 'https://www.googleapis.com/urlshortener/v1/url';

/**
 * Shortens an url
 * @param {String} longUrl
 * @returns {Promise}
 */
var shortenUrl = function(longUrl) {
    var deferred = q.defer();
    var parameters = {
        key: process.env.GOOGLE_API_KEY
    };
    var requestBody = {
        longUrl: longUrl
    };

    request.post({
            url: shortenerUrl,
            qs: parameters,
            body: requestBody,
            json: true
        },
        function(error, response, body) {
            if (!error && response.statusCode == 200) {
                deferred.resolve(body.id);
            } else {
                deferred.reject(error);
            }
        });

    return deferred.promise;
};

module.exports = {
    shortenUrl: shortenUrl
};