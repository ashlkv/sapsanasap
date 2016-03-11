// it seems that {silent: true} option disables console.log if .config() generates a warning.
require('dotenv').config();

var http = require('http');
var Analyzer = require('./analyzer');

var requestListener = function(request, response) {
    response.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
    console.log('request', request);
    Analyzer.analyze()
        .then(function(text) {
            response.end(text);
        });
};

var main = function() {
    http.createServer(requestListener).listen(process.env.PORT || 5000);
};

main();
