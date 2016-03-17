require('dotenv').config({silent: true});

var http = require('http');
var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');

var requestListener = function(request, response) {
    response.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
    Analyzer.analyze()
        .then(function(roundtrip) {
            response.end(Kiosk.formatRoundtrip(roundtrip));
        });
};

var main = function() {
    http.createServer(requestListener).listen(process.env.PORT || 5000);
};

main();
