(function (B, global) {
    B.env = B.env || {};

    var errorQueue = [];

    // Need to bind this immediately, so we can report errors that happen after
    // this file has loaded, but before the test runner is initialized
    window.onerror = function () {
        errorQueue.push(arguments);
    };

    // Globally uncaught errors will be emitted as messages through
    // the test runner
    function handleUncaughtError(runner, args) {
        if (args.length >= 3) {
            var message = args[0];
            var url = args[1];
            var line = args[2];

            var cp = B.env.contextPath || window.location;
            var index = (url || "").indexOf(cp);
            if (index >= 0) {
                url = "." + url.slice(index + cp.length);
            }

            if (line === 1 && message === "Error loading script") {
                message = "Unable to load script " + url;
            } else if (url) {
                message = url + ":" + line + " " + message;
            } else {
                message = message.replace("uncaught exception: ", "");
            }
        }

        runner.emit("uncaughtException", {
            name: "UncaughtError",
            message: message,
            runtime: runner.runtime
        });

        return true;
    };

    // When the runner is set up, replace the temporary uncaught error listener,
    // and pass possible existing errors through the runner.
    function handleUncaughtErrors(runner) {
        for (var i = 0, l = errorQueue.length; i < l; ++i) {
            handleUncaughtError(runner, errorQueue[i]);
        }

        window.onerror = function () {
            handleUncaughtError(runner, arguments);
        };
    }

    // Emit messages from the evented logger buster.console through
    // the test runner
    function monitorLogger(runner) {
        B.console.on("log", function (msg) {
            runner.emit("log", msg);
        });
    }

    // Collect test cases and specs created with buster.testCase
    // and buster.spec.describe
    function collectTestContexts() {
        var contexts = [];
        B.addTestContext = function (context) { contexts.push(context); };
        B.testContext.on("create", B.addTestContext);
        return contexts;
    }

    // Clear scripts and use the browserEnv object from buster-test to
    // reset the document between tests runs
    function monitorDocumentState(runner) {
        var scripts = document.getElementsByTagName("script"), script;
        while ((script = scripts[0])) {
            script.parentNode.removeChild(script);
        }
        var env = B.browserEnv.create(document.body);
        env.listen(runner);
    }

    function shouldAutoRun(config) {
        var autoRunPropertyIsSet = config.hasOwnProperty("autoRun");
        return config.autoRun || !autoRunPropertyIsSet;
    }

    function shouldResetDoc(config) {
        var resetDocumentPropertyIsSet = config.hasOwnProperty("resetDocument");
        return config.resetDocument || !resetDocumentPropertyIsSet;
    }

    // Wire up the test runner. It will start running tests when
    // the environment is ready and when we've been told to run.
    // Note that run() and ready() may occur in any order, and
    // we cannot do anything until both have happened.
    //
    // When running tests with buster-server, we'll be ready() when
    // the server sends the "commence" message. This message is sent
    // by the server when it receives the "runtime:ready" message
    // from the browser. We'll usually run as soon as we're ready.
    // However, if the autoRun option is false, we will not run
    // until buster.run() is explicitly called.
    //
    // For static browser runs, the environment is ready() when
    // ready() is called, which happens after all files have been
    // loaded in the browser. Tests will run immediately for autoRun:
    // true, and on run() otherwise.
    //
    function configureTestRunner(runner) {
        var ctxts = collectTestContexts();
        var ready, started, alreadyRunning, config;

        function attemptRun() {
            if (!ready || !started || alreadyRunning) { return; }
            alreadyRunning = true;
            if (typeof runner === "function") { runner = runner(); }
            if (shouldResetDoc(config)) { monitorDocumentState(runner); }
            if (config.captureConsole) { B.captureConsole(); }

            for (var prop in config) {
                runner[prop] = config[prop];
            }

            runner.runSuite(B.testContext.compile(ctxts, config.filters));
        }

        return {
            ready: function (options) {
                config = options || {};
                ready = true;
                started = started || shouldAutoRun(config);
                attemptRun();
            },

            run: function () {
                started = true;
                attemptRun();
            }
        };
    }

    // Wire it all up and wait for window.onload before
    var runner = B.testRunner.create({ runtime: navigator.userAgent });
    monitorLogger(runner);
    handleUncaughtErrors(runner);
    B.reporters.jsonProxy.create(B).listen(runner);
    var wiring = configureTestRunner(runner);
    B.run = wiring.run;

    var subscribe = buster.on("commence", function (options) {
        wiring.ready(options);
    });

    window.onload = function () {
        subscribe.then(function () {
            buster.emit("runtime:ready");
        });
    };

    // Efficient nextTick/setImmediate in the browser. Stripped down version of
    // https://raw.github.com/NobleJS/setImmediate/master/setImmediate.js
    buster.nextTick = (function () {
        "use strict";

        var tasks = (function () {
            function Task(handler, args) {
                this.handler = handler;
                this.args = args;
            }
            Task.prototype.run = function () {
                // See steps in section 5 of the spec.
                if (typeof this.handler === "function") {
                    // Choice of `thisArg` is not in the setImmediate spec; `undefined` is in the setTimeout spec though:
                    // http://www.whatwg.org/specs/web-apps/current-work/multipage/timers.html
                    this.handler.apply(undefined, this.args);
                } else {
                    var scriptSource = "" + this.handler;
                    /*jshint evil: true */
                    eval(scriptSource);
                }
            };

            var nextHandle = 1; // Spec says greater than zero
            var tasksByHandle = {};
            var currentlyRunningATask = false;

            return {
                addFromSetImmediateArguments: function (args) {
                    var handler = args[0];
                    var argsToHandle = Array.prototype.slice.call(args, 1);
                    var task = new Task(handler, argsToHandle);

                    var thisHandle = nextHandle++;
                    tasksByHandle[thisHandle] = task;
                    return thisHandle;
                },
                runIfPresent: function (handle) {
                    // From the spec: "Wait until any invocations of this algorithm started before this one have completed."
                    // So if we're currently running a task, we'll need to delay this invocation.
                    if (!currentlyRunningATask) {
                        var task = tasksByHandle[handle];
                        if (task) {
                            currentlyRunningATask = true;
                            try {
                                task.run();
                            } finally {
                                delete tasksByHandle[handle];
                                currentlyRunningATask = false;
                            }
                        }
                    } else {
                        // Delay by doing a setTimeout. setImmediate was tried instead, but in Firefox 7 it generated a
                        // "too much recursion" error.
                        setTimeout(function () {
                            tasks.runIfPresent(handle);
                        }, 0);
                    }
                },
                remove: function (handle) {
                    delete tasksByHandle[handle];
                }
            };
        }());

        function canUsePostMessage() {
            // The test against `importScripts` prevents this implementation from being installed inside a web worker,
            // where `global.postMessage` means something completely different and can't be used for this purpose.

            if (!global.postMessage || global.importScripts) {
                return false;
            }

            var postMessageIsAsynchronous = true;
            var oldOnMessage = global.onmessage;
            global.onmessage = function () {
                postMessageIsAsynchronous = false;
            };
            global.postMessage("", "*");
            global.onmessage = oldOnMessage;

            return postMessageIsAsynchronous;
        }

        function canUseReadyStateChange() {
            return "document" in global && "onreadystatechange" in global.document.createElement("script");
        }

        function postMessageImplementation() {
            // Installs an event handler on `global` for the `message` event: see
            // * https://developer.mozilla.org/en/DOM/window.postMessage
            // * http://www.whatwg.org/specs/web-apps/current-work/multipage/comms.html#crossDocumentMessages

            var MESSAGE_PREFIX = "com.bn.NobleJS.setImmediate" + Math.random();

            function isStringAndStartsWith(string, putativeStart) {
                return typeof string === "string" && string.substring(0, putativeStart.length) === putativeStart;
            }

            function onGlobalMessage(event) {
                // This will catch all incoming messages (even from other windows!), so we need to try reasonably hard to
                // avoid letting anyone else trick us into firing off. We test the origin is still this window, and that a
                // (randomly generated) unpredictable identifying prefix is present.
                if (event.source === global && isStringAndStartsWith(event.data, MESSAGE_PREFIX)) {
                    var handle = event.data.substring(MESSAGE_PREFIX.length);
                    tasks.runIfPresent(handle);
                }
            }
            if (global.addEventListener) {
                global.addEventListener("message", onGlobalMessage, false);
            } else {
                global.attachEvent("onmessage", onGlobalMessage);
            }

            return function () {
                var handle = tasks.addFromSetImmediateArguments(arguments);

                // Make `global` post a message to itself with the handle and identifying prefix, thus asynchronously
                // invoking our onGlobalMessage listener above.
                global.postMessage(MESSAGE_PREFIX + handle, "*");

                return handle;
            };
        }

        function readyStateChangeImplementation() {
            return function () {
                var handle = tasks.addFromSetImmediateArguments(arguments);

                // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
                // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
                var scriptEl = global.document.createElement("script");
                scriptEl.onreadystatechange = function () {
                    tasks.runIfPresent(handle);

                    scriptEl.onreadystatechange = null;
                    scriptEl.parentNode.removeChild(scriptEl);
                    scriptEl = null;
                };
                global.document.documentElement.appendChild(scriptEl);

                return handle;
            };
        }

        function setTimeoutImplementation() {
            return function () {
                var handle = tasks.addFromSetImmediateArguments(arguments);

                global.setTimeout(function () {
                    tasks.runIfPresent(handle);
                }, 0);

                return handle;
            };
        }

        if (global.setImmediate) {
            return global.setImmediate;
        }

        if (canUsePostMessage()) {
            // For non-IE10 modern browsers
            return postMessageImplementation();
        } else if (canUseReadyStateChange()) {
            // For IE 6–8
            return readyStateChangeImplementation();
        } else {
            // For older browsers
            return setTimeoutImplementation();
        }
    }());
}(buster, typeof global === "object" && global ? global : this));

buster.sinon = sinon;
delete this.sinon;
delete this.define;
delete this.when;
delete this.async;
delete this.platform;
delete this._;
