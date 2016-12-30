require('dotenv').config({silent: true});
var debug = require('debug')('collect');

var Collector = require('./../collector');
var Kiosk = require('./../kiosk');

Collector.fetch()
    .then(function() {
        return Collector.getAll();
    })
    .then(function(allTickets) {
        return Kiosk.generateIndex(allTickets);
    })
    .then(function() {
        debug('Successfully generated index.');
        debug('Collector finished.');
    })
    .catch(function(error) {
        console.log(error && error.stack);
    });