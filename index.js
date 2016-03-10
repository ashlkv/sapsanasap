var http = require('http');

var Analyzer = require('./analyzer');

// After running, go to http://localhost:5000 to see hello world message
http.createServer(function (request, response) {
    response.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
    Analyzer.analyze()
        .then(function(text) {
            response.end(text);
        });
}).listen(process.env.PORT || 5000);