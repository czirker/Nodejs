"use strict";

var aws = require("aws-sdk");
var extend = require("extend");
var elasticsearch = require('elasticsearch');
var refUtil = require("../../lib/reference.js");
var moment = require("moment");
var https = require("https");

var async = require("async");

module.exports = function (configure) {
	configure = configure || {};
	let leo = require("../../index")(configure);
	let ls = leo.streams;

	var s3 = new aws.S3({
		apiVersion: '2006-03-01',
		httpOptions: {
			agent: new https.Agent({
				keepAlive: true
			})
		},
		accessKeyId: configure.bus.accessKeyId,
		secretAccessKey: configure.bus.secretAccessKey
	});

	function getClient(settings) {
		var client;
		if (settings.client) {
			client = settings.client;
		} else {
			let config = new aws.Config();
			let esSettings = extend(true, {
				connectionClass: require('http-aws-es'),
				amazonES: {
					region: configure.aws.region,
					credentials: config.credentials
				}
			}, settings);
			client = elasticsearch.Client(esSettings);
		}

		return client;
	}

	let self;
	return self = {
		validate: function () {

		},
		stream: function (settings) {
			let connection = settings.connection || settings
			let client = getClient(connection);
			let requireType = settings.requireType || false;
			let total = settings.startTotal || 0;
			let fileCount = 0;
			let format = ls.through({
				highWaterMark: 16
			}, function (event, done) {
				let data = event.payload || event;

				if (!data || !data.index || (requireType && !data.type) || !data.id) {
					console.log("Invalid data. index, type, & id are required", JSON.stringify(data || ""));
					done("Invalid data. index, type, & id are required " + JSON.stringify(data || ""));
					return;
				}
				let meta = Object.assign({}, event);
				delete meta.payload;
				var deleteByQuery = [];
				if (data.delete && data.delete == true) {
					if (!data.field || data.field == "_id") {
						this.push(meta, {
							delete: {
								_index: data.index,
								_type: data.type,
								_id: data.id
							}
						});
					} else {
						var ids = Array.isArray(data.id) ? data.id : [data.id];
						var size = ids.length;
						var chunk = 1000;
						for (var i = 0; i < size; i += chunk) {
							deleteByQuery.push({
								index: data.index,
								type: data.type,
								query: {
									terms: {
										[data.field]: ids.slice(i, i + chunk)
									}
								}
							});
						}
					}
				} else {
					this.push(meta, {
						update: {
							_index: data.index,
							_type: data.type,
							_id: data.id
						}
					}, {
						doc: data.doc,
						doc_as_upsert: true
					});
				}
				if (deleteByQuery.length) {
					self.getIds(deleteByQuery, client, (err, ids) => {
						if (err) {
							done(err);
						} else {
							ids.forEach(id => this.push(meta, {
								delete: {
									_index: data.index,
									_type: data.type,
									_id: id
								}
							}));
							done();
						}
					});
				} else {
					done();
				}
			}, function flush(callback) {
				settings.debug && console.log("Transform: On Flush");
				callback();
			});

			format.push = (function (self, push) {
				return function (meta, command, data) {
					if (command == null) {
						push.call(self, null);
						return;
					}
					var result = JSON.stringify(command) + "\n";
					if (data) {
						result += JSON.stringify(data) + "\n";
					}
					push.call(self, Object.assign({}, meta, {
						payload: result
					}));
				}
			})(format, format.push);

			let systemRef = refUtil.ref(settings.system, "system")
			let send = ls.through({
				highWaterMark: 16
			}, (input, done) => {
				if (input.payload && input.payload.length) {
					let meta = Object.assign({}, input);
					meta.event = systemRef.refId();
					//meta.units = input.payload.length;
					delete meta.payload;

					total += input.payload.length;
					settings.logSummary && console.log("ES Object Size:", input.bytes, input.payload.length, total);
					let body = input.payload.map(a => a.payload).join("");
					if (process.env.dryrun) {
						done(null, Object.assign(meta, {
							payload: {
								body: body,
								response: data
							}
						}));
					} else {
						client.bulk({
							body: body,
							fields: false,
							_source: false
						}, function (err, data) {
							if (err || data.errors) {
								if (data && data.Message) {
									err = data.Message;
								} else if (data && data.items) {
									console.log(data.items.filter((r) => {
										return 'error' in r.update;
									}).map(e => JSON.stringify(e, null, 2)));
									//console.log(JSON.stringify(bulk, null,  2));
									err = "Cannot load";
								} else {
									//console.log(JSON.stringify(bulk, null,  2));
									console.log(err);
									err = "Cannot load";
								}
							}
							if (err) {
								console.log(err)
							}

							let timestamp = moment();
							let rand = Math.floor(Math.random() * 1000000);
							let key = `files/elasticsearch/${(systemRef && systemRef.id) || "unknown"}/${meta.id || "unknown"}/${timestamp.format("YYYY/MM/DD/HH/mm/")+timestamp.valueOf()}-${++fileCount}-${rand}`;

							if (!settings.dontSaveResults) {
								s3.upload({
									Bucket: leo.configuration.bus.s3,
									Key: key,
									Body: JSON.stringify({
										body: body,
										response: data
									})
								}, (uploaderr, data) => {
									//console.log("ES Done", meta)
									done(err, Object.assign(meta, {
										payload: {
											file: data && data.Location,
											error: err || undefined,
											uploadError: uploaderr || undefined
										}
									}));
								});
							} else {
								done(err);
							}
						});
					}
				} else {
					done();
				}
			}, function flush(callback) {
				settings.debug && console.log("Elasticsearch Upload: On Flush");
				callback();
			});


			return ls.pipeline(format, ls.batch({
				count: 1000,
				bytes: 10485760 * 0.95, // 9.5MB
				time: {
					milliseconds: 200
				},
				field: "payload"
			}), send);
		},

		getIds: function (queries, client, done) {
			// Run any deletes and finish
			var allIds = [];
			async.eachSeries(queries, (data, callback) => {
				this.query({
					index: data.index,
					type: data.type,
					query: data.query,
					source: ["_id"],
					scroll: "15s",
				}, {
					client: client
				}, (err, ids) => {
					if (err) {
						callback(err);
						return;
					}
					//console.log(ids)
					allIds = allIds.concat(ids.items.map(id => id._id));
					callback();
				});

			}, (err) => {
				if (err) {
					console.log(err)
					done(err);
				} else {
					done(null, allIds);
				}
			})
		},
		query: function (data, settings, callback) {
			if (!callback) {
				callback = settings;
				settings = {};
			}

			let connection = settings.connection || settings
			var client = getClient(connection);

			var results = {
				took: 0,
				qty: 0,
				items: [],
				scrolls: []
			};

			var max = data.max != undefined ? data.max : 100000;
			var source = data.source;
			var transforms = {
				full: function (item) {
					return item;
				},
				source: function (item) {
					return item._source;
				}
			}
			var transform;

			if (typeof data.return == "function") {
				transform = data.return;
			} else {
				transform = transforms[data.return || "full"] || transforms.full;
			}

			var scroll = data.scroll;

			function getUntilDone(err, data) {
				if (err) {
					console.log(err);
					callback(err);
					return;
				}
				if (data.aggregations) {
					results.aggregations = data.aggregations;
				}
				var info = data.hits;
				info.qty = info.hits.length;
				results.qty += info.qty;
				results.took += data.took;

				info.hits.forEach(item => {
					results.items.push(transform(item));
				});
				delete info.hits

				results.total = info.total
				results.scrolls.push(info)

				delete results.scrollid;

				if (info.qty > 0 && info.total !== results.qty) {
					results.scrollid = data._scroll_id
				}

				if (scroll && info.total !== results.qty && max > results.qty && results.scrollid) {
					client.scroll({
						scrollId: data._scroll_id,
						scroll: scroll
					}, getUntilDone)
				} else {
					//console.log(JSON.stringify(results, null, 2))
					callback(null, results);
				};
			}

			if (data.scrollid) {
				configure.debug && console.log("Starting As Scroll");
				client.scroll({
					scrollId: data.scrollid,
					scroll: scroll
				}, getUntilDone);
			} else {
				configure.debug && console.log("Starting As Query")
				var index = data.index;
				var type = data.type;
				var query = data.query;
				var sort = data.sort;
				var size = Math.min(max, data.size != undefined ? data.size : 10000);

				// From doesn't seem to work properly.  It appears to be ignored
				var from = data.from || 0;

				configure.debug && console.log(JSON.stringify({
					index: index,
					type: type,
					body: {
						query: query,
						sort: sort,
						from: from,
						size: size,
						aggs: data.aggs,
						_source: source,
					},
					scroll: scroll
				}, null, 2));

				client.search({
					index: index,
					type: type,
					body: {
						query: query,
						sort: sort,
						from: from,
						size: size,
						aggs: data.aggs,
						_source: source,
					},
					scroll: scroll
				}, getUntilDone);
			}
		}
	}
};