
/**
 * Module dependencies
 */
var redis = require('redis');
var reds = require('reds');
// redis.debug_mode = true;
var _ = require('underscore');
var fs = require('fs');

exports.initialize = function initializeSchema(schema, callback) {
    if (!redis) return;

    //load the comparer.lua template
    schema.comparerTemplate = fs.readFileSync(__dirname + '/comparer.lua');

    //comparer sha cache
    schema.comparers = {};

    if (schema.settings.url) {
        var url = require('url');
        var redisUrl = url.parse(schema.settings.url);
        var redisAuth = (redisUrl.auth || '').split(':');
        schema.settings.host = redisUrl.hostname;
        schema.settings.port = redisUrl.port;

        if (redisAuth.length == 2) {
            schema.settings.db = redisAuth[0];
            schema.settings.password = redisAuth[1];
        }
    }

    schema.client = redis.createClient(
        schema.settings.port,
        schema.settings.host,
        schema.settings.options
    );
    reds.client = schema.client;
    schema.client.auth(schema.settings.password);
    schema.client.on('connect', function () {
        if (schema.settings.database) {
            var cb = callback.called ? function () {} : callback;
            callback.called = true;
            return schema.client.select(schema.settings.database, cb);
        }
        if (callback.called) return;
        callback.called = true;
        callback();
    });

    if (!schema.adapter) {
        schema.adapter = new RedisHQ(schema.client);
        schema.adapter.schema = schema;
    } else {
        schema.adapter.client = schema.client;
    }

    schema.reconnect = function (cb) {
        if (schema.connected) return cb();;
        initializeSchema(schema, function () {
            console.log('connected');
            schema.connected = true;
            cb();
        });
    };
};

function RedisHQ(client) {
    this._models = {};
    this.client = client;
    this.indexes = {};
}

[ 'sinterstore'
, 'zinterstore'
, 'expire'
, 'incr'
, 'lpush'
, 'lrange'
, '_exists'
, 'get'
, 'mget'
, 'set'
, 'del'
, 'sadd'
, 'zadd'
, 'srem'
, 'zrem'
, 'smembers'
, 'zrange'
, 'zrevrange'
, 'keys'
, 'sort'
, 'eval'
, 'evalsha'
, 'script load'
].forEach(function (cmd) {

    var ccmd = cmd.replace('_', '');

    RedisHQ.prototype[cmd] = function (args, callback) {
        
        var c = this.client, log;

        if (typeof args === 'string') {
            args = [args];
        }

        log = this.logger(cmd.toUpperCase() + ' ' + args.join(' ') + '');
        args.push(function (err, res) {
            if (err) console.log(err);
            log();
            if (callback) {
                callback(err, res);
            }
        });

        c[ccmd].apply(c, args);
    };
});

RedisHQ.prototype.multi = function (commands, callback) {
    if (commands.length === 0) return callback();
    if (commands.length === 1) {
        return this[commands[0].shift().toLowerCase()].call(
            this,
            commands[0],
            callback && function (e, r) { callback(e, [r]) });
    }
    var log = this.logger('MULTI\n  ' + commands.map(function (x) {
        return x.join(' ');
    }).join('\n  ') + '\nEXEC');
    this.client.multi(commands).exec(function (err, replies) {
        if (err) console.log(err);
        log();
        callback(err, replies);
    });
};

RedisHQ.prototype.modelName = function modelName(model) {
    if (this.schema.settings.prefix) {
        return this.schema.settings.prefix + '/' + model;
    } else {
        return model;
    }
};

RedisHQ.prototype.transaction = function () {
    var redis = this;
    var schedule = [];
    var handlers = [];
    var transaction = {
        exec: function (cb) {
            redis.multi(schedule, function (err, replies) {
                if (err) return cb(err);
                replies.forEach(function (r, i) {
                    if (handlers[i]) {
                        handlers[i](err, r);
                    }
                });
            });
        }
    };
    ['sinterstore', 'zinterstore', 'sadd', 'zadd', 'expire', 'sort', 'scard', 'smembers', 'zrange', 'zrevrange', 'keys', 'eval', 'evalsha'].forEach(function (k) {
        transaction[k] = function (args, cb) {
            if (typeof args === 'string') {
                args = [args];
            }
            args.unshift(k);
            schedule.push(args);
            handlers.push(cb || false);
        };
    });
    return transaction;
};

RedisHQ.prototype.define = function (descr) {
    var m = descr.model.modelName;
    this._models[m] = descr;
    this.indexes[m] = {};
    Object.keys(descr.properties).forEach(function (prop) {
        if (descr.properties[prop].index) {
            this.indexes[m][prop] = [descr.properties[prop].type];
        }
    }.bind(this));
};

RedisHQ.prototype.defineForeignKey = function (model, key, cb) {
    this.indexes[model][key] = [Number];
    cb(null, Number);
};

RedisHQ.prototype.defineProperty = function (model, property, definition) {
    this._models[model].properties[property] = definition;
    if (definition.index) {
        this.indexes[model][property] = [definition.type || Number];
    }
};

RedisHQ.prototype.defineFulltextIndex = function (model, property) {
    this._models[model].properties[property].fulltext = true;
};

/**
 * Define index for nested collection
 * Usage example:
 *
 *     User.memberships (JSON) = [{groupId: 1, state: pending}]
 *     hq.defineNestedIndex('User', 'memberships:groupId');
 *     i:User:memberships:groupId:1 = User:1
 *
 *     hq.defineNestedIndex('User', 'memberships:state');
 *     i:User:memberships:state:pending = User:1
 *
 *     User.all({'memberships:groupId': 1, 'memberships:state': 'pending'});
 */
RedisHQ.prototype.defineNestedIndex = function (model, key, type, pk) {
    this.indexes[model][key] = [type, pk];
};

RedisHQ.prototype.fromDb = function (model, r) {
    console.log(r.length + " bytes");
    var data = JSON.parse(r);
    var p = this._models[model].properties;
    for (var i in p) {
        if (p[i].type.name === 'Date') {
            if (data[i]) {
                data[i] = new Date(data[i]);
            }
        }
    }
    return data;
};

RedisHQ.prototype.save = function (model, data, callback) {
    var hq = this;

    hq.find(model, data.id, function (err, initialData) {
        var updatedData = {};
        if (initialData) {
            Object.keys(initialData).forEach(function (key) {
                updatedData[key] = initialData[key];
            });
        }
        Object.keys(data).forEach(function (key) {
            updatedData[key] = data[key];
        });

        hq.set([hq.modelName(model) + ':' + data.id, JSON.stringify(updatedData)], function (err) {
            if (err) return callback(err);
            hq.updateIndexes(model, data.id, updatedData, callback, initialData);
        });
    });
};

RedisHQ.prototype.updateIndexes = function (model, id, data, callback, prevData) {
    var redis = this;
    var i = this.indexes[model];
    var p = this._models[model].properties;
    var schedule = [['ZADD', 'z:' + redis.modelName(model), id, id]];

    function getVal(set, name) {
        var val = set && set[name];
        if (p[name].type.name === 'Date') {
            if (val && val.getTime) {
                val = val.getTime();
            } else {
                val = 0;
            }
        }
        if (p[name].type.name == 'JSON') {
            val = eval(val);
        }

        return val;
    }

    // remove regular indexes
    Object.keys(i).forEach(function (key) {
        if (key.indexOf(':') !== -1) return;
        var prevVal = getVal(prevData, key);
        var curVal = getVal(data, key);
        if (typeof data[key] === 'undefined' || prevData && prevVal !== curVal) {
            if (!prevVal || prevVal.constructor.name !== 'Array') {
                prevVal = [prevVal];
            }

            prevVal.forEach(function (v) {
                schedule.push([
                    'ZREM',
                    'z:' + redis.modelName(model) + ':' + key + ':' + v,
                    id
                ]);
            });

        }
    });

    // add regular indexes
    Object.keys(data).forEach(function (key) {
        if (i[key]) {
            var val = getVal(data, key);

            if (!val || val.constructor.name !== 'Array') {
                val = [val];
            }

            val.forEach(function (v) {
                schedule.push([
                    'ZADD',
                    'z:' + redis.modelName(model) + ':' + key + ':' + v,
                    id,
                    id
                ]);
            });

        }
    });

    // fulltext indexes
    var fti = [], atLeastOne = false;
    Object.keys(data).forEach(function (key) {
        if (p[key] && p[key].fulltext) {
            if (data[key]) {
                atLeastOne = true;
            }
            fti.push(data[key]);
        }
    });
    if (this.schema.fulltextSearch) {
        if (atLeastOne) {
            this.schema.fulltextSearch.update(this.modelName(model), id, fti.join(' '));
        } else {
            this.schema.fulltextSearch.remove(this.modelName(model), id);
        }
    }

    // nested indexes
    Object.keys(i).forEach(function (nested) {
        var n = nested.split(':');
        var attrName = n[0], nestedName = n[1];

        var attr = data[attrName], attrWas = prevData && prevData[attrName];
        if (n.length < 2 || !attr) return;
        var pk = i[nested][1];
        if (typeof attr === 'string') attr = JSON.parse(attr);
        if (typeof attrWas === 'string') attrWas = JSON.parse(attrWas);
        var preiousIndex = {};
        var currentIndex = {};
        if (attr instanceof Array) {
            attr.forEach(function (nestedRecord) {
                currentIndex[nestedRecord[pk]] = nestedRecord;
            });
        }
        if (attrWas instanceof Array) {
            attrWas.forEach(function (nestedRecord) {
                preiousIndex[nestedRecord[pk]] = nestedRecord;
                // if record was removed
                if (!currentIndex[nestedRecord[pk]]) {
                    // remove from common index
                    var val = nestedRecord[nestedName];
                    if (val instanceof Date) {
                        val = val.getTime();
                    }
                    if (!val || val.constructor.name !== 'Array') {
                        val = [val];
                    }
                    val.forEach(function (v) {
                        schedule.push([
                            'SREM',
                            'i:' + redis.modelName(model) + ':' + nested + ':' + v,
                            id
                        ]);
                        // remove from pk-restricted index
                        schedule.push([
                            'SREM',
                            'i:' + redis.modelName(model) + ':' + nested + ':' + nestedRecord[pk] + ':' + v,
                            id
                        ]);
                    });
                }
            });
        }
        if (attr instanceof Array) {
            attr.forEach(function (record) {
                var recordWas  = preiousIndex[record[pk]];
                // now we have two nested records: current and previos state
                // when it doesn't changed: nothing to do
                var prev = recordWas && recordWas[nestedName];
                var cur = record[nestedName];
                if (cur instanceof Date) {
                    cur = cur.getTime();
                }
                if (prev instanceof Date) {
                    prev = prev.getTime();
                }
                if (recordWas && prev === cur) {
                    return;
                }
                // otherwise we need to remove old index and add new index
                else {
                    var pki = record[pk] + ':';
                    if (!cur || cur.constructor.name !== 'Array') {
                        cur = [cur];
                    }
                    cur.forEach(function (c) {
                        schedule.push([
                            'SADD',
                            'i:' + redis.modelName(model) + ':' + nested + ':' + c,
                            id
                        ]);
                        schedule.push([
                            'SADD',
                            'i:' + redis.modelName(model) + ':' + nested + ':' + pki + c,
                            id
                        ]);
                        schedule.push([
                            'SET',
                            's:' + redis.modelName(model) + ':' + id + ':' + pki + nested,
                            c
                        ]);
                    });
                    if (recordWas) {
                        if (!prev || prev.constructor.name !== 'Array') {
                            prev = [prev];
                        }
                        prev.forEach(function (p) {
                            schedule.push([
                                'SREM',
                                'i:' + redis.modelName(model) + ':' + nested + ':' + p,
                                id
                            ]);
                            schedule.push([
                                'SREM',
                                'i:' + redis.modelName(model) + ':' + nested + ':' + pki + p,
                                id
                            ]);
                        });
                    }
                }
            });
        }
    });

    if (schedule.length) {
        this.multi(schedule, function (err) {
            callback(err, data);
        });
    } else {
        callback(null);
    }
};

RedisHQ.prototype.create = function (model, data, callback) {
    if (data.id) return create.call(this, data.id, true);

    this.incr('id:' + this.modelName(model), function (err, id) {
        create.call(this, id);
    }.bind(this));

    function create(id, upsert) {
        data.id = id;
        this.save(model, data, function (err) {
            if (callback) {
                callback(err, id);
            }
        });

        // push the id to the list of user ids for sorting
        this.sadd(["s:" + this.modelName(model), upsert ? data : data.id]);
    }
};

RedisHQ.prototype.updateOrCreate = function (model, data, callback) {
    var r = this;
    if (!data.id) return this.create(model, data, callback);
    this.save(model, data, function (error, obj) {
        var key = 'id:' + r.modelName(model);
        r.client.get(key, function (err, id) {
            if (!id || data.id > parseInt(id, 10)) {
                r.client.set(key, data.id, callback.bind(null, error, obj));
            } else {
                callback(error, obj);
            }
        });
    });
};

RedisHQ.prototype.exists = function (model, id, callback) {
    this._exists(this.modelName(model) + ':' + id, callback);
};

RedisHQ.prototype.find = function find(model, id, callback) {
    this.get(this.modelName(model) + ':' + id, function (err, data) {
        if (data) {
            try {
                data = this.fromDb(model, data);
                data.id = id;
            } catch (e) {
                data = null;
            }
        } else {
            data = null;
        }
        callback(err, data);
    }.bind(this));
};

RedisHQ.prototype.destroy = function destroy(model, id, callback) {
    var indexes = this.indexes[model];
    var dataWas = [];
    var foundNested = [];
    var foundIndex = false;
    var regularIndex = [];
    var hq = this;

    if (indexes) {
        Object.keys(indexes).forEach(function (index) {
            if (index.indexOf(':') !== -1) {
                foundNested.push(index.split(':')[0]);
            } else {
                regularIndex.push(index);
                foundIndex = true;
            }
        });
    }

    if (foundNested.length || foundIndex) {
        this.find(model, id, function (err, data) {
            var curData = {};
            foundNested.forEach(function (i) {
                curData[i] = [];
            });
            hq.updateIndexes(model, id, curData, done, data);
        });
    } else {
        done();
    }

    function done () {
        hq.del(hq.modelName(model) + ':' + id, function (err) {
            callback(err);
        });
        hq.zrem(["z:" + hq.modelName(model), id]);
    }
};

RedisHQ.prototype.possibleIndexes = function (model, filter) {
    if (!filter || Object.keys(filter.where || {}).length === 0) return false;

    var foundIndex = [];
    var luaIndex = [];
    var noIndex = [];
    Object.keys(filter.where).forEach(function (key) {
        var val = filter.where[key];

        if(typeof val === 'object' && val.lua && typeof val.value !== 'undefined') {
            // push the whole key into the foundIndex so it can be processed by the lua function
            luaIndex.push(val);
        } else if (this.indexes[model][key]) {
            // add primary key for nested indexes (if any)
            var pk = this.indexes[model][key].pk || '';
            if (pk && key.indexOf(':') !== -1) {
                pk = key.split(':')[0] + ':' + pk;
                if (filter.where[pk] && key !== pk) {
                    pk = filter.where[pk] + ':';
                } else {
                    pk = '';
                }
            } else {
                pk = '';
            }
            if (val instanceof Date) {
                val = val.getTime();
            }
            foundIndex.push('z:' + this.modelName(model) + ':' + key + ':' + pk + val);
        } else {
            if (key !== 'id') {
                noIndex.push(key);
            }
        }
    }.bind(this));

    return [foundIndex, luaIndex, noIndex];
};

RedisHQ.prototype.all = function all(model, filter, callback) {

    var redis = this;
    var sortCmd = [];
    var props = this._models[model].properties;
    var allNumeric = true;
    var dest = 'temp' + Math.round((Math.random() * Date.now()));
    var usingTempList = false;
    var modelIndexes = this.indexes[model];
    var transaction = this.transaction();
    var countBeforeLimit;
    var ft = null;

    // fulltext
    if (filter && filter.fulltext) {
        ft = filter.fulltext;
        if (typeof ft === 'string') {
            this.schema.fulltextSearch.queryNS(redis.modelName(model), ft, function (err, ids) {
                if (err) {
                    callback(err);
                } else if (!ids || ids.length === 0) {
                    callback(err, []);
                } else {
                    if (!filter.where) {
                        filter.where = {};
                    }
                    delete filter.fulltext;
                    filter.where.id = ids;
                    all.call(redis, model, filter, callback);
                }
            });
            return;
        }
    }

    // WHERE
    if (filter && filter.where) {
        var pi = this.possibleIndexes(model, filter);
        var indexes = pi[0];
        var luaIndexes = pi[1];
        var noIndexes = pi[2];

        if (indexes && indexes.length || filter.where.id) {
            if (filter.where.id) {
                indexes.unshift(dest);
                transaction.zadd([dest].concat([filter.where.id, filter.where.id]));
            }
            if (noIndexes.length) {
                throw new Error('No indexes for ' + noIndexes.join(', '));
            }
            usingTempList = true;
            if (indexes.length > 1 || indexes.length === 1 && filter.intersect) {
                indexes.unshift(indexes.length + (filter.intersect ? 1 : 0));
                indexes.unshift(dest);
                if (filter.intersect) {
                    indexes.push(filter.intersect);
                }
                transaction.zinterstore(indexes);
                transaction.expire([dest, 7]); // TODO: think about replacing with DEL
            } else if (indexes.length === 1) {
                dest = indexes[0];
            }

            //now process any lua indexes
            if(luaIndexes.length > 0) {
                //check to see if the script exists
                luaIndexes.forEach(function(index) {
                    var scriptSha = schema.comparers[index.lua];
                    var key = 'luaTemp' + Math.round((Math.random() * Date.now()));

                    if(!scriptSha) {
                        //generate the full script
                        var script = schema.comparerTemplate.toString().replace('--SCRIPT--', index.lua).replace('--TYPE--', redis.modelName(model));
                        transaction.eval([script, 4, key, dest, index.value, index.limit || 0]);

                        //meanwhile, cache the script sha so we can use it later
                        //redis.script(['load', script], function(result) { schema.comparers[script] = result; });
                    }
                    else {
                        transaction.evalsha([scriptSha, 4, key, dest, index.value, index.limit || 0]);
                    }

                    //we now have a new destination key - remember it
                    dest = key;
                });
            }
        } else {
            throw new Error('No indexes for query: ' + JSON.stringify(filter));
        }
    }

    if (filter && filter.limit && !filter.order) {
        filter.order = 'id';
    }

    // LIMIT
    if (filter && filter.limit){
        transaction.scard(dest, function (err, count) {
            countBeforeLimit = count;
        });
        var from = (filter.offset || 0), to = filter.limit;
        sortCmd.push("LIMIT", from, to);
    }

    var rangeCmd = filter && filter.reverse === false ? 'zrange' : 'zrevrange';

    if (!usingTempList) {
        if (ft && ft.length) {
            return handleKeys(null, ft);
        } else {
            transaction[rangeCmd]([
                'z:' + redis.modelName(model),
                0, -1
            ], handleKeys);
        }
    } else {
        transaction[rangeCmd]([
            dest, 0, -1
        ], handleKeys);
    }

    transaction.exec(callback);

    function handleKeys(err, keys) {
        console.log(arguments);
        if (err || !keys || !keys.length) return callback(err, []);

        var t2 = Date.now();
        if (filter && filter.onlyKeys) return callback(err, keys);

        var query = keys.map(function (key) {
            if (key.toString().indexOf(':') === -1) {
                key = redis.modelName(model) + ':' + key;
            }
            return key;
        });

        redis.mget(query, function (err, replies) {
            if (!replies) return callback(err, []);

            var start = new Date();
            replies = replies.map(function (r) {
                try {
                    return redis.fromDb(model, r);
                } catch (e) {
                    console.log(e);
                    console.log(r);
                }
            });
            console.log((new Date() - start) + "ms");
            replies.countBeforeLimit = countBeforeLimit || replies.length;
            callback(err, replies);
        });
    }

};

RedisHQ.prototype.destroyAll = function destroyAll(model, callback) {
    var redis = this;
    // TODO: two queries for keys (*:Model:* and Model:*)
    var keysQuery = '*' + this.modelName(model) + ':*', redis = this;
    this.keys(keysQuery, function (err, keys) {
        if (err) {
            return callback(err, []);
        }
        var query = keys.map(function (key) {
            return ['del', key];
        });
        redis.multi(query, function (err, replies) {
            redis.del('z:' + redis.modelName(model), function () {
                callback(err);
            });
        });
    });
};

RedisHQ.prototype.count = function count(model, callback, where) {
    var keysQuery = this.modelName(model) + ':*';
    var t1 = Date.now();
    if (where && Object.keys(where).length) {
        this.all(model, {where: where, onlyKeys: true}, function (err, data) {
            callback(err, err ? null : data.length);
        });
    } else {
        this.keys(keysQuery, function (err, keys) {
            callback(err, err ? null : keys.length);
        }.bind(this));
    }
};

RedisHQ.prototype.updateAttributes = function updateAttrs(model, id, data, cb) {
    data.id = id;
    this.save(model, data, cb);
};

RedisHQ.prototype.disconnect = function disconnect() {
    this.log('QUIT', Date.now());
    this.client.quit();
};
