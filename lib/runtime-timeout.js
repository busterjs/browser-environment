var bane = require("bane");

module.exports = {
    monitor: function (runner, timeout) {
        var emitter = bane.createEventEmitter();
        timeout = timeout || 10000;
        var pings = {};
        var timedout = {};

        runner.on(function (event, data) {
            if (!data.uuid) {
                emitter.emit(event, data);
                return;
            }

            if (!timedout[data.uuid]) {
                emitter.emit(event, data);
            }

            clearTimeout(pings[data.uuid]);
            pings[data.uuid] = setTimeout(function () {
                timedout[data.uuid] = true;
                emitter.emit("runtime:timeout", { uuid: data.uuid });
            }, timeout);
        });

        return emitter;
    }
};
