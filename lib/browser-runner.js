var when = require("when");
var pipeline = require("when/pipeline");
var bane = require("bane");
var ramp = require("ramp");
var addResources = require("./browser-resources").addResources;

module.exports.createRunner = function (resourceSet) {
    var runtimeReady = when.defer();
    var suiteEnd = when.defer();
    var timeouts = 0;
    addResources(resourceSet);

    function start(rampClient, session) {
        var d = when.defer();

        suiteEnd.then(function (data) {
            rampClient.destroy();
            d.resolve(data);
        });

        runtimeReady.then(session.emit.bind(session, "commence", {
            failOnNoAssertions: true,
            autoRun: true,
            captureConsole: true
        }));
        return d.promise;
    }

    var runner = bane.createEventEmitter();

    function unwrapRampEvents(runner) {
        return function (eventName, event) {
            // event is ramp's wrapped event data object.
            // event.data is the original event data from the testRunner in
            // the browser.
            // The test runner creates an uuid associated with a run, and
            // attaches it to every event through event.data.uuid
            // Ramp also attaches a uuid to all its event wrappers;
            // event.slaveId. We prefer using Ramp's id, because this allows
            // us to know which client times out if we get a slaveDeath
            // event (in this case the test runner is not involved)
            event.data = event.data || {};
            event.data.uuid = event.slaveId;

            if (event.data.runtime) {
                event.data.runtime.uuid = event.slaveId;
            }

            runner.emit(eventName, event.data);
        }
    }

    var rampClient;

    function prepare(options) {
        var d = when.defer();
        rampClient = ramp.createRampClient(options.port, options.host);

        rampClient.createSession(resourceSet, {
            staticResourcesPath: options.staticResourcesPath
        }).then(function (initializer) {
            initializer.onSlaveDeath(function (e) {
                runner.emit("runtime:timeout", { uuid: e.slaveId });
            });

            initializer.onSessionAbort(function () {
                d.reject(new Error("Session aborted"));
            });

            pipeline([
                function () {
                    return when.all([
                        initializer.on(unwrapRampEvents(runner)),
                        initializer.on("suite:end", suiteEnd.resolve),
                        initializer.on("runtime:ready", runtimeReady.resolve)
                    ]);
                },
                initializer.initialize.bind(initializer),

                function (session) {
                    return {
                        getRuntimes: session.getInitialSlaves.bind(session),
                        start: start.bind(null, rampClient, session)
                    };
                }
            ]).then(d.resolve, d.reject);
        }, d.reject);

        return d.promise;
    }

    runner.prepare = prepare;

    runner.stop = function (callback) {
        if (rampClient) {
            rampClient.destroy(callback);
        } else {
            callback();
        }
    };

    return runner;
};
