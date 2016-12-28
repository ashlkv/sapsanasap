require('dotenv').config({silent: true});
var debug = require('debug')('collect');

var Collector = require('./../collector');

Collector.testIntegrity();