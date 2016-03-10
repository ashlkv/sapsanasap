// TODO Get rid of unirest
var unirest = require('unirest');
var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var q = require('q');
var _ = require('lodash');

var BASE_URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/`;
var POLLING_URL = BASE_URL + "getUpdates?offset=:offset:&timeout=60";
var SEND_MESSAGE_URL = BASE_URL + "sendMessage";

function poll(offset) {
    var url = POLLING_URL.replace(":offset:", offset);

    unirest.get(url)
        .end(function(userResponse) {
            var result = getLastResult(userResponse);
            var max_offset;

            if (result.message) {
                reply(result.message);
            }
            max_offset = parseInt(result.update_id) + 1; // update max offset
            poll(max_offset);
        });
}

var getLastResult = function(response) {
    var results = [];
    if (response.status === 200) {
        var jsonData = JSON.parse(response.raw_body);
        results = jsonData.result;
        results = _.isArray(results) ? results : [{message: results}];
    }
    return results.length > 0 ? _.last(results) : {};
};

function ask(userMessage) {
    var chatId = userMessage.chat.id;
    var text = userMessage.text;
    var toMoscowPattern = /в москву|в мск|из питера|из петербурга|из санкт|из спб/i;
    var toSpbPattern = /из москвы|из мск|в питер|в петербург|в санкт|в спб/i;
    var deferred = q.defer();

    // To Moscow
    if (toMoscowPattern.test(text)) {
        deferred.resolve({
            route: Kiosk.toMoscow()
        });
    // To Spb
    } else if (toSpbPattern.test(text)) {
        deferred.resolve({
            route: Kiosk.toSpb()
        });
    } else {
        // If the route is not clear, ask for a route
        unirest.post(SEND_MESSAGE_URL)
            .send({
                chat_id: chatId,
                text: 'В Москву или Петербург?'
            })
            .end(function(response) {
                if (response.status == 200) {
                    console.log("Successfully sent message to " + chatId);
                }
            });
    }

    return deferred.promise;
}

var reply = function(userMessage) {
    var chatId = userMessage.chat.id;
    ask(userMessage)
        .then(function(options) {
            return Analyzer.analyze(options);
        })
        .then(function(response) {
            unirest.post(SEND_MESSAGE_URL)
                .send({
                    chat_id: chatId,
                    text: response
                })
                .end(function(response) {
                    if (response.status == 200) {
                        console.log("Successfully sent message to " + chatId);
                    }
                });
        });
};

poll();
