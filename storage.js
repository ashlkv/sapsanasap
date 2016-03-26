var q = require('q');
var mongoClient = require('mongodb').MongoClient;

var connection;

const collectionName = {
    tickets: 'tickets',
    roundtrips: 'roundtrips',
    settings: 'settings'
};

/**
 * @returns {Promise}
 */
var connect = function() {
    var deferred = q.defer();
    // If connection already exists, use existing connection.
    // It is recommended to only connect once and reuse that one connection: http://stackoverflow.com/questions/10656574
    if (connection) {
        deferred.resolve(connection);
    // If connection is not yet created, connect and store resulting connection.
    } else {
        mongoClient.connect(process.env.MONGOLAB_URI, function(error, db) {
            if (!error) {
                // Store connection
                connection = db;
                deferred.resolve(connection);
            } else {
                deferred.reject(error);
            }
        });
    }
    return deferred.promise;
};

var insert = function(collectionName, items) {
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
    collectionName: collectionName,
    insert: insert,
    find: find,
    drop: drop
};
