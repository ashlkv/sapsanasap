require('dotenv').config({silent: true});
var debug = require('debug')('reindex');

var Collector = require('./../collector');
var Kiosk = require('./../kiosk');

Kiosk.remove()
    .then(function() {
        return Collector.getAll();
    })
    .then(function(allTickets) {
        return Kiosk.generateIndex(allTickets);
    })
    .then(function() {
        debug('Successfully generated index.');
        debug('Reindex finished.');
    })
    .catch(function(error) {
        console.log(error && error.stack);
    });