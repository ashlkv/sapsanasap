require('dotenv').config({silent: true});
var debug = require('debug')('app');

var Bot = require('./bot');
Bot.main();
