var q = require('q');
var mongoClient = require('mongodb').MongoClient;

const collectionNames = {
    tickets: 'tickets'
};

/**
 * @returns {Promise}
 */
var connect = function() {
    var deferred = q.defer();
    mongoClient.connect(process.env.MONGOLAB_URI, function(error, db) {
        if (!error) {
            deferred.resolve(db);
        } else {
            deferred.reject(error);
        }
    });
    return deferred.promise;
};

var insert = function(items, collectionName) {
    return connect().then(function(db) {
        var collection = db.collection(collectionName);
        return collection.insert(items);
    });
};

var find = function(collectionName, query) {
    query = query || {};
    return connect().then(function(db) {
        var collection = db.collection(collectionName);
        return collection.find(query).toArray();
    });
};

var drop = function(collectionName) {
    return connect()
        .then(function(db) {
            var collection = db.collection(collectionName);
            return collection.drop();
        })
        // Collection.drop will throw exception if collection does not exist. Catch the exception and resolve promise anyway.
        .catch(function() {
            return true;
        });
};

module.exports = {
    collectionNames: collectionNames,
    insert: insert,
    find: find,
    drop: drop
};
