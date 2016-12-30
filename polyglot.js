const Polyglot = require('node-polyglot');
const _ = require('lodash');
// TODO Determine locale
// TODO Per-user locale, not per-instance locale
const locale = process.env.LOCALE || 'en';

const moment = require('moment');
moment.locale(locale);

const SapsanPolyglot = function() {
	Polyglot.call(this);
};

SapsanPolyglot.prototype = Object.create(Polyglot.prototype);

// Extending polyglot extend method to allow non-string values (e.g. regexps and functions)
SapsanPolyglot.prototype.extend = function(morePhrases, prefix) {
	_.forEach(morePhrases, function(phrase, key) {
		var prefixedKey = prefix ? prefix + '.' + key : key;
		this.phrases[prefixedKey] = phrase;
	}.bind(this));
};

// Extending polyglot translate method to allow non-string values (e.g. regexps and functions)
SapsanPolyglot.prototype.t = function(key, options) {
	var phrase = this.phrases[key];
	var result;
	if (typeof phrase === 'function' || typeof phrase === 'object' ||  _.isRegExp(phrase)) {
		result = phrase
	} else  {
		result = Polyglot.prototype.t.call(this, key, options);
	}
	return result;
};

var polyglot;

const getInstance = function() {
	if (!polyglot) {
		polyglot = new SapsanPolyglot();
		polyglot.locale(locale);
		var locales;
		try {
			locales = require('./locales/' + locale);
		}
		catch (err) {
			locales = require('./locales/en');
		}
		polyglot.extend(locales);
	}
	return polyglot;
};

module.exports = getInstance;
