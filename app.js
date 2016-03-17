require('dotenv').config({silent: true});
var debug = require('debug')('app');

var moment = require('moment');
moment.locale('ru');

var Bot = require('./bot');
Bot.main();
