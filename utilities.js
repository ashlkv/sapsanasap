var request = require('request-promise');
var Promise = require('bluebird');

var debug = require('debug')('utilities');

const shortenerUrl = 'https://www.googleapis.com/urlshortener/v1/url';

/**
 * Shortens an url
 * @param {String} longUrl
 * @returns {Promise}
 */
var shortenUrl = function(longUrl) {
    var parameters = {
        key: process.env.GOOGLE_API_KEY
    };
    var requestBody = {
        longUrl: longUrl
    };

    // TODO Test what happens http error (status other than 200)
    return request({
            method: 'POST',
            url: shortenerUrl,
            qs: parameters,
            body: requestBody,
            resolveWithFullResponse: true,
            json: true
    }).then(function(response) {
        var body = response.body;
        return body.id;
    }).catch(function() {
        throw new Error('Unable to shorten the url');
    });
};

module.exports = {
    shortenUrl: shortenUrl
};