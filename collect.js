require('dotenv').config({silent: true});
var assert = require('assert');
var Collector = require('./collector');

/**
 * Interval in minutes
 * @type {number}
 */
const interval = 20;

// Additional interval check
assert(interval >= 15, 'Interval too short');

setInterval(function() {
    Collector.main();
}, interval * 60 * 1000);