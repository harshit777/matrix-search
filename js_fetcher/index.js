"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const argv_1 = __importDefault(require("argv"));
const lodash_get_1 = __importDefault(require("lodash.get"));
const winston = __importStar(require("winston"));
const mkdirp = __importStar(require("mkdirp"));
// import Olm before importing js-sdk to prevent it crying
global.Olm = require('olm');
const matrix_js_sdk_1 = require("matrix-js-sdk");
// side-effect upgrade MatrixClient prototype
require("./matrix_client_ext");
// side-effect upgrade Map and Set prototypes
require("./builtin_ext");
const Queue = require('better-queue');
const SqliteStore = require('better-queue-sqlite');
const request = require('request-promise');
const LocalStorageCryptoStore = require('matrix-js-sdk/lib/crypto/store/localStorage-crypto-store').default;
// create directory which will house the stores.
mkdirp.sync('./store');
// Loading localStorage module
if (typeof global.localStorage === "undefined" || global.localStorage === null)
    global.localStorage = new (require('node-localstorage').LocalStorage)('./store/localStorage');
matrix_js_sdk_1.setCryptoStoreFactory(() => new LocalStorageCryptoStore(global.localStorage));
argv_1.default.option([
    {
        name: 'url',
        type: 'string',
        description: 'The URL to be used to connect to the Matrix HS',
    }, {
        name: 'username',
        type: 'string',
        description: 'The username to be used to connect to the Matrix HS',
    }, {
        name: 'password',
        type: 'string',
        description: 'The password to be used to connect to the Matrix HS',
    }, {
        name: 'port',
        type: 'int',
        description: 'Port to bind to (default 8000)',
    }
]);
const logger = new winston.Logger({
    level: 'info',
    transports: [
        new winston.transports.Console({ colorize: true })
    ]
});
class BleveHttp {
    constructor(baseUrl) {
        this.request = request.defaults({ baseUrl });
    }
    enqueue(events) {
        return this.request({
            url: 'enqueue',
            method: 'POST',
            json: true,
            body: events,
        });
    }
}
const b = new BleveHttp("http://localhost:8000/api/");
function indexable(ev) {
    return indexableKeys.some((key) => lodash_get_1.default(ev, key) !== undefined);
}
const q = new Queue(async (batch, cb) => {
    try {
        cb(null, await b.enqueue(batch));
    }
    catch (e) {
        cb(e);
    }
}, {
    batchSize: 100,
    maxRetries: 100,
    retryDelay: 5000,
    store: new SqliteStore({
        path: './store/queue.sqlite',
    }),
});
q.on('task_queued', function (task_id, ev) {
    const { room_id, event_id, sender, type } = ev;
    if (ev.redacts) {
        logger.info('enqueue event for redaction', { room_id, event_id, task_id });
    }
    else {
        logger.info('enqueue event for indexing', { room_id, event_id, sender, type, task_id });
    }
});
q.on('batch_failed', function (error) {
    logger.error('batch failed', { error });
});
setup().then();
// debug disable js-sdk log spam
const disableConsoleLogger = false;
if (disableConsoleLogger) {
    console.log = function () { };
    console.warn = function () { };
    console.error = function () { };
    console.error = function () { };
}
const FILTER_BLOCK = {
    not_types: ['*'],
    limit: 0,
};
async function setup() {
    const args = argv_1.default.run();
    const baseUrl = args.options['url'] || 'https://matrix.org';
    let creds = {
        userId: global.localStorage.getItem('userId'),
        deviceId: global.localStorage.getItem('deviceId'),
        accessToken: global.localStorage.getItem('accessToken'),
    };
    if (!creds.userId || !creds.deviceId || !creds.accessToken) {
        if (!args.options['username'] || !args.options['password']) {
            logger.error('username and password were not specified on the commandline and none were saved');
            argv_1.default.help();
            process.exit(-1);
        }
        const loginClient = matrix_js_sdk_1.createClient({ baseUrl });
        try {
            const res = await loginClient.login('m.login.password', {
                user: args.options['username'],
                password: args.options['password'],
                initial_device_display_name: 'Matrix Search Daemon',
            });
            logger.info('logged in', { user_id: res.user_id });
            global.localStorage.setItem('userId', res.user_id);
            global.localStorage.setItem('deviceId', res.device_id);
            global.localStorage.setItem('accessToken', res.access_token);
            creds = {
                userId: res.user_id,
                deviceId: res.device_id,
                accessToken: res.access_token,
            };
        }
        catch (error) {
            logger.error('an error occurred logging in', { error });
            process.exit(1);
        }
    }
    const cli = matrix_js_sdk_1.createClient(Object.assign({ baseUrl, idBaseUrl: '' }, creds, { useAuthorizationHeader: true, store: new matrix_js_sdk_1.MatrixInMemoryStore({
            localStorage: global.localStorage,
        }), sessionStore: new matrix_js_sdk_1.WebStorageSessionStore(global.localStorage) }));
    cli.on('event', (event) => {
        if (event.isEncrypted())
            return;
        const cev = event.getClearEvent();
        // if event can be redacted or is a redaction then enqueue it for processing
        if (event.getType() === "m.room.redaction" || !indexable(cev))
            return;
        return q.push(cev);
    });
    cli.on('Event.decrypted', (event) => {
        if (event.isDecryptionFailure()) {
            logger.warn('decryption failure', { event: event.event });
            return;
        }
        const cev = event.getClearEvent();
        if (!indexable(cev))
            return;
        return q.push(cev);
    });
    // cli.on('Room.redaction', (event: MatrixEvent) => {
    //     return q.push({
    //         type: JobType.redact,
    //         event: event.getClearEvent(),
    //     });
    // });
    try {
        logger.info('initializing crypto');
        await cli.initCrypto();
    }
    catch (error) {
        logger.error('failed to init crypto', { error });
        process.exit(-1);
    }
    logger.info('crypto initialized');
    // create sync filter
    const filter = new matrix_js_sdk_1.Filter(cli.credentials.userId);
    filter.setDefinition({
        room: {
            include_leave: false,
            // ephemeral: FILTER_BLOCK, // we don't care about ephemeral events
            account_data: FILTER_BLOCK,
            // state: FILTER_BLOCK, // TODO: do we care about state
            timeline: {
                limit: 20,
            },
        },
        presence: FILTER_BLOCK,
        account_data: FILTER_BLOCK,
    });
    try {
        logger.info('loading/creating sync filter');
        filter.filterId = await cli.getOrCreateFilter(filterName(cli), filter);
    }
    catch (error) {
        logger.error('failed to getOrCreate sync filter', { error });
        process.exit(-1);
    }
    logger.info('sync filter loaded', { filter_id: filter.getFilterId() });
    logger.info('starting client');
    // filter sync to improve performance
    cli.startClient({
        disablePresence: true,
        filter,
    });
    logger.info('client started - fetcher has begun');
}
// TODO groups-pagination
// TODO backfill
// TODO gapfill
function filterName(cli) {
    return `MATRIX_SEARCH_FILTER_${cli.credentials.userId}`;
}
var RequestKey;
(function (RequestKey) {
    RequestKey["body"] = "content.body";
    RequestKey["name"] = "content.name";
    RequestKey["topic"] = "content.topic";
})(RequestKey || (RequestKey = {}));
const indexableKeys = [RequestKey.body, RequestKey.name, RequestKey.topic];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7QUFNQSxnREFBd0I7QUFDeEIsNERBQTZCO0FBQzdCLGlEQUFtQztBQUNuQywrQ0FBaUM7QUFJakMsMERBQTBEO0FBQzFELE1BQU0sQ0FBQyxHQUFHLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBRTVCLGlEQWdCdUI7QUFDdkIsNkNBQTZDO0FBQzdDLCtCQUE2QjtBQUM3Qiw2Q0FBNkM7QUFDN0MseUJBQXVCO0FBRXZCLE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUN0QyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMscUJBQXFCLENBQUMsQ0FBQztBQUNuRCxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsaUJBQWlCLENBQUMsQ0FBQztBQUUzQyxNQUFNLHVCQUF1QixHQUFHLE9BQU8sQ0FBQywwREFBMEQsQ0FBQyxDQUFDLE9BQU8sQ0FBQztBQUU1RyxnREFBZ0Q7QUFDaEQsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUN2Qiw4QkFBOEI7QUFDOUIsSUFBSSxPQUFPLE1BQU0sQ0FBQyxZQUFZLEtBQUssV0FBVyxJQUFJLE1BQU0sQ0FBQyxZQUFZLEtBQUssSUFBSTtJQUMxRSxNQUFNLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO0FBRWxHLHFDQUFxQixDQUFDLEdBQUcsRUFBRSxDQUFDLElBQUksdUJBQXVCLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7QUFFOUUsY0FBSSxDQUFDLE1BQU0sQ0FBQztJQUNSO1FBQ0ksSUFBSSxFQUFFLEtBQUs7UUFDWCxJQUFJLEVBQUUsUUFBUTtRQUNkLFdBQVcsRUFBRSxnREFBZ0Q7S0FDaEUsRUFBRTtRQUNDLElBQUksRUFBRSxVQUFVO1FBQ2hCLElBQUksRUFBRSxRQUFRO1FBQ2QsV0FBVyxFQUFFLHFEQUFxRDtLQUNyRSxFQUFFO1FBQ0MsSUFBSSxFQUFFLFVBQVU7UUFDaEIsSUFBSSxFQUFFLFFBQVE7UUFDZCxXQUFXLEVBQUUscURBQXFEO0tBQ3JFLEVBQUU7UUFDQyxJQUFJLEVBQUUsTUFBTTtRQUNaLElBQUksRUFBRSxLQUFLO1FBQ1gsV0FBVyxFQUFFLGdDQUFnQztLQUNoRDtDQUNKLENBQUMsQ0FBQztBQUVILE1BQU0sTUFBTSxHQUFHLElBQUksT0FBTyxDQUFDLE1BQU0sQ0FBQztJQUM5QixLQUFLLEVBQUUsTUFBTTtJQUNiLFVBQVUsRUFBRTtRQUNSLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsRUFBQyxRQUFRLEVBQUUsSUFBSSxFQUFDLENBQUM7S0FDbkQ7Q0FDSixDQUFDLENBQUM7QUFFSDtJQUdJLFlBQVksT0FBZTtRQUN2QixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsRUFBQyxPQUFPLEVBQUMsQ0FBQyxDQUFDO0lBQy9DLENBQUM7SUFFRCxPQUFPLENBQUMsTUFBb0I7UUFDeEIsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDO1lBQ2hCLEdBQUcsRUFBRSxTQUFTO1lBQ2QsTUFBTSxFQUFFLE1BQU07WUFDZCxJQUFJLEVBQUUsSUFBSTtZQUNWLElBQUksRUFBRSxNQUFNO1NBQ2YsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztDQUNKO0FBRUQsTUFBTSxDQUFDLEdBQUcsSUFBSSxTQUFTLENBQUMsNEJBQTRCLENBQUMsQ0FBQztBQUV0RCxtQkFBbUIsRUFBUztJQUN4QixPQUFPLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFXLEVBQUUsRUFBRSxDQUFDLG9CQUFHLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxLQUFLLFNBQVMsQ0FBQyxDQUFDO0FBQzNFLENBQUM7QUFFRCxNQUFNLENBQUMsR0FBRyxJQUFJLEtBQUssQ0FBQyxLQUFLLEVBQUUsS0FBbUIsRUFBRSxFQUFFLEVBQUUsRUFBRTtJQUNsRCxJQUFJO1FBQ0EsRUFBRSxDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztLQUNwQztJQUFDLE9BQU8sQ0FBQyxFQUFFO1FBQ1IsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0tBQ1Q7QUFDTCxDQUFDLEVBQUU7SUFDQyxTQUFTLEVBQUUsR0FBRztJQUNkLFVBQVUsRUFBRSxHQUFHO0lBQ2YsVUFBVSxFQUFFLElBQUk7SUFDaEIsS0FBSyxFQUFFLElBQUksV0FBVyxDQUFDO1FBQ25CLElBQUksRUFBRSxzQkFBc0I7S0FDL0IsQ0FBQztDQUNMLENBQUMsQ0FBQztBQUVILENBQUMsQ0FBQyxFQUFFLENBQUMsYUFBYSxFQUFFLFVBQVMsT0FBZSxFQUFFLEVBQVM7SUFDbkQsTUFBTSxFQUFDLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBQyxHQUFHLEVBQUUsQ0FBQztJQUM3QyxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUU7UUFDWixNQUFNLENBQUMsSUFBSSxDQUFDLDZCQUE2QixFQUFFLEVBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUMsQ0FBQyxDQUFDO0tBQzVFO1NBQU07UUFDSCxNQUFNLENBQUMsSUFBSSxDQUFDLDRCQUE0QixFQUFFLEVBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBQyxDQUFDLENBQUM7S0FDekY7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILENBQUMsQ0FBQyxFQUFFLENBQUMsY0FBYyxFQUFFLFVBQVMsS0FBSztJQUMvQixNQUFNLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxFQUFDLEtBQUssRUFBQyxDQUFDLENBQUM7QUFDMUMsQ0FBQyxDQUFDLENBQUM7QUFFSCxLQUFLLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUVmLGdDQUFnQztBQUNoQyxNQUFNLG9CQUFvQixHQUFHLEtBQUssQ0FBQztBQUNuQyxJQUFJLG9CQUFvQixFQUFFO0lBQ3RCLE9BQU8sQ0FBQyxHQUFHLEdBQUcsY0FBVyxDQUFDLENBQUM7SUFDM0IsT0FBTyxDQUFDLElBQUksR0FBRyxjQUFXLENBQUMsQ0FBQztJQUM1QixPQUFPLENBQUMsS0FBSyxHQUFHLGNBQVcsQ0FBQyxDQUFDO0lBQzdCLE9BQU8sQ0FBQyxLQUFLLEdBQUcsY0FBVyxDQUFDLENBQUM7Q0FDaEM7QUFFRCxNQUFNLFlBQVksR0FBRztJQUNqQixTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7SUFDaEIsS0FBSyxFQUFFLENBQUM7Q0FDWCxDQUFDO0FBRUYsS0FBSztJQUNELE1BQU0sSUFBSSxHQUFHLGNBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUV4QixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLG9CQUFvQixDQUFDO0lBRTVELElBQUksS0FBSyxHQUFHO1FBQ1IsTUFBTSxFQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztRQUM3QyxRQUFRLEVBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDO1FBQ2pELFdBQVcsRUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUM7S0FDMUQsQ0FBQztJQUVGLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsSUFBSSxDQUFDLEtBQUssQ0FBQyxXQUFXLEVBQUU7UUFDeEQsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxFQUFFO1lBQ3hELE1BQU0sQ0FBQyxLQUFLLENBQUMsaUZBQWlGLENBQUMsQ0FBQztZQUNoRyxjQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDWixPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDcEI7UUFFRCxNQUFNLFdBQVcsR0FBaUIsNEJBQVksQ0FBQyxFQUFDLE9BQU8sRUFBQyxDQUFDLENBQUM7UUFFMUQsSUFBSTtZQUNBLE1BQU0sR0FBRyxHQUFHLE1BQU0sV0FBVyxDQUFDLEtBQUssQ0FBQyxrQkFBa0IsRUFBRTtnQkFDcEQsSUFBSSxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDO2dCQUM5QixRQUFRLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUM7Z0JBQ2xDLDJCQUEyQixFQUFFLHNCQUFzQjthQUN0RCxDQUFDLENBQUM7WUFFSCxNQUFNLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxFQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsT0FBTyxFQUFDLENBQUMsQ0FBQztZQUNqRCxNQUFNLENBQUMsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ25ELE1BQU0sQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7WUFDdkQsTUFBTSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUU3RCxLQUFLLEdBQUc7Z0JBQ0osTUFBTSxFQUFFLEdBQUcsQ0FBQyxPQUFPO2dCQUNuQixRQUFRLEVBQUUsR0FBRyxDQUFDLFNBQVM7Z0JBQ3ZCLFdBQVcsRUFBRSxHQUFHLENBQUMsWUFBWTthQUNoQyxDQUFDO1NBQ0w7UUFBQyxPQUFPLEtBQUssRUFBRTtZQUNaLE1BQU0sQ0FBQyxLQUFLLENBQUMsOEJBQThCLEVBQUUsRUFBQyxLQUFLLEVBQUMsQ0FBQyxDQUFDO1lBQ3RELE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDbkI7S0FDSjtJQUVELE1BQU0sR0FBRyxHQUFpQiw0QkFBWSxpQkFDbEMsT0FBTyxFQUNQLFNBQVMsRUFBRSxFQUFFLElBQ1YsS0FBSyxJQUNSLHNCQUFzQixFQUFFLElBQUksRUFDNUIsS0FBSyxFQUFFLElBQUksbUNBQW1CLENBQUM7WUFDM0IsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZO1NBQ3BDLENBQUMsRUFDRixZQUFZLEVBQUUsSUFBSSxzQ0FBc0IsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLElBQy9ELENBQUM7SUFFSCxHQUFHLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFDLEtBQWtCLEVBQUUsRUFBRTtRQUNuQyxJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUU7WUFBRSxPQUFPO1FBRWhDLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxhQUFhLEVBQUUsQ0FBQztRQUNsQyw0RUFBNEU7UUFDNUUsSUFBSSxLQUFLLENBQUMsT0FBTyxFQUFFLEtBQUssa0JBQWtCLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDO1lBQUUsT0FBTztRQUN0RSxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDdkIsQ0FBQyxDQUFDLENBQUM7SUFDSCxHQUFHLENBQUMsRUFBRSxDQUFDLGlCQUFpQixFQUFFLENBQUMsS0FBa0IsRUFBRSxFQUFFO1FBQzdDLElBQUksS0FBSyxDQUFDLG1CQUFtQixFQUFFLEVBQUU7WUFDN0IsTUFBTSxDQUFDLElBQUksQ0FBQyxvQkFBb0IsRUFBRSxFQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSyxFQUFDLENBQUMsQ0FBQztZQUN4RCxPQUFPO1NBQ1Y7UUFFRCxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsYUFBYSxFQUFFLENBQUM7UUFDbEMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUM7WUFBRSxPQUFPO1FBQzVCLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUN2QixDQUFDLENBQUMsQ0FBQztJQUVILHFEQUFxRDtJQUNyRCxzQkFBc0I7SUFDdEIsZ0NBQWdDO0lBQ2hDLHdDQUF3QztJQUN4QyxVQUFVO0lBQ1YsTUFBTTtJQUVOLElBQUk7UUFDQSxNQUFNLENBQUMsSUFBSSxDQUFDLHFCQUFxQixDQUFDLENBQUM7UUFDbkMsTUFBTSxHQUFHLENBQUMsVUFBVSxFQUFFLENBQUM7S0FDMUI7SUFBQyxPQUFPLEtBQUssRUFBRTtRQUNaLE1BQU0sQ0FBQyxLQUFLLENBQUMsdUJBQXVCLEVBQUUsRUFBQyxLQUFLLEVBQUMsQ0FBQyxDQUFDO1FBQy9DLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztLQUNwQjtJQUNELE1BQU0sQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUVsQyxxQkFBcUI7SUFDckIsTUFBTSxNQUFNLEdBQUcsSUFBSSxzQkFBTSxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDbEQsTUFBTSxDQUFDLGFBQWEsQ0FBQztRQUNqQixJQUFJLEVBQUU7WUFDRixhQUFhLEVBQUUsS0FBSztZQUNwQixtRUFBbUU7WUFDbkUsWUFBWSxFQUFFLFlBQVk7WUFDMUIsdURBQXVEO1lBQ3ZELFFBQVEsRUFBRTtnQkFDTixLQUFLLEVBQUUsRUFBRTthQUNaO1NBQ0o7UUFDRCxRQUFRLEVBQUUsWUFBWTtRQUN0QixZQUFZLEVBQUUsWUFBWTtLQUM3QixDQUFDLENBQUM7SUFFSCxJQUFJO1FBQ0EsTUFBTSxDQUFDLElBQUksQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO1FBQzVDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsTUFBTSxHQUFHLENBQUMsaUJBQWlCLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0tBQzFFO0lBQUMsT0FBTyxLQUFLLEVBQUU7UUFDWixNQUFNLENBQUMsS0FBSyxDQUFDLG1DQUFtQyxFQUFFLEVBQUMsS0FBSyxFQUFDLENBQUMsQ0FBQztRQUMzRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7S0FDcEI7SUFDRCxNQUFNLENBQUMsSUFBSSxDQUFDLG9CQUFvQixFQUFFLEVBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxXQUFXLEVBQUUsRUFBQyxDQUFDLENBQUM7SUFFckUsTUFBTSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO0lBQy9CLHFDQUFxQztJQUNyQyxHQUFHLENBQUMsV0FBVyxDQUFDO1FBQ1osZUFBZSxFQUFFLElBQUk7UUFDckIsTUFBTTtLQUNULENBQUMsQ0FBQztJQUNILE1BQU0sQ0FBQyxJQUFJLENBQUMsb0NBQW9DLENBQUMsQ0FBQztBQUN0RCxDQUFDO0FBRUQseUJBQXlCO0FBQ3pCLGdCQUFnQjtBQUNoQixlQUFlO0FBRWYsb0JBQW9CLEdBQWlCO0lBQ2pDLE9BQU8sd0JBQXdCLEdBQUcsQ0FBQyxXQUFXLENBQUMsTUFBTSxFQUFFLENBQUM7QUFDNUQsQ0FBQztBQUVELElBQUssVUFJSjtBQUpELFdBQUssVUFBVTtJQUNYLG1DQUFxQixDQUFBO0lBQ3JCLG1DQUFxQixDQUFBO0lBQ3JCLHFDQUF1QixDQUFBO0FBQzNCLENBQUMsRUFKSSxVQUFVLEtBQVYsVUFBVSxRQUlkO0FBRUQsTUFBTSxhQUFhLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFVBQVUsQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiZGVjbGFyZSB2YXIgZ2xvYmFsOiB7XG4gICAgT2xtOiBhbnlcbiAgICBsb2NhbFN0b3JhZ2U/OiBhbnlcbiAgICBhdG9iOiAoc3RyaW5nKSA9PiBzdHJpbmc7XG59O1xuXG5pbXBvcnQgYXJndiBmcm9tICdhcmd2JztcbmltcG9ydCBnZXQgZnJvbSAnbG9kYXNoLmdldCc7XG5pbXBvcnQgKiBhcyB3aW5zdG9uIGZyb20gJ3dpbnN0b24nO1xuaW1wb3J0ICogYXMgbWtkaXJwIGZyb20gJ21rZGlycCc7XG5pbXBvcnQge1JlcXVlc3RQcm9taXNlLCBSZXF1ZXN0UHJvbWlzZU9wdGlvbnN9IGZyb20gJ3JlcXVlc3QtcHJvbWlzZSc7XG5pbXBvcnQge1JlcXVlc3RBUEksIFJlcXVpcmVkVXJpVXJsfSBmcm9tICdyZXF1ZXN0JztcblxuLy8gaW1wb3J0IE9sbSBiZWZvcmUgaW1wb3J0aW5nIGpzLXNkayB0byBwcmV2ZW50IGl0IGNyeWluZ1xuZ2xvYmFsLk9sbSA9IHJlcXVpcmUoJ29sbScpO1xuXG5pbXBvcnQge1xuICAgIFJvb20sXG4gICAgRXZlbnQsXG4gICAgRmlsdGVyLFxuICAgIE1hdHJpeCxcbiAgICBNYXRyaXhFdmVudCxcbiAgICBVc2VyUHJvZmlsZSxcbiAgICBjcmVhdGVDbGllbnQsXG4gICAgRXZlbnRDb250ZXh0LFxuICAgIE1hdHJpeENsaWVudCxcbiAgICBJbmRleGVkREJTdG9yZSxcbiAgICBFdmVudFdpdGhDb250ZXh0LFxuICAgIE1hdHJpeEluTWVtb3J5U3RvcmUsXG4gICAgSW5kZXhlZERCQ3J5cHRvU3RvcmUsXG4gICAgc2V0Q3J5cHRvU3RvcmVGYWN0b3J5LFxuICAgIFdlYlN0b3JhZ2VTZXNzaW9uU3RvcmUsXG59IGZyb20gJ21hdHJpeC1qcy1zZGsnO1xuLy8gc2lkZS1lZmZlY3QgdXBncmFkZSBNYXRyaXhDbGllbnQgcHJvdG90eXBlXG5pbXBvcnQgJy4vbWF0cml4X2NsaWVudF9leHQnO1xuLy8gc2lkZS1lZmZlY3QgdXBncmFkZSBNYXAgYW5kIFNldCBwcm90b3R5cGVzXG5pbXBvcnQgJy4vYnVpbHRpbl9leHQnO1xuXG5jb25zdCBRdWV1ZSA9IHJlcXVpcmUoJ2JldHRlci1xdWV1ZScpO1xuY29uc3QgU3FsaXRlU3RvcmUgPSByZXF1aXJlKCdiZXR0ZXItcXVldWUtc3FsaXRlJyk7XG5jb25zdCByZXF1ZXN0ID0gcmVxdWlyZSgncmVxdWVzdC1wcm9taXNlJyk7XG5cbmNvbnN0IExvY2FsU3RvcmFnZUNyeXB0b1N0b3JlID0gcmVxdWlyZSgnbWF0cml4LWpzLXNkay9saWIvY3J5cHRvL3N0b3JlL2xvY2FsU3RvcmFnZS1jcnlwdG8tc3RvcmUnKS5kZWZhdWx0O1xuXG4vLyBjcmVhdGUgZGlyZWN0b3J5IHdoaWNoIHdpbGwgaG91c2UgdGhlIHN0b3Jlcy5cbm1rZGlycC5zeW5jKCcuL3N0b3JlJyk7XG4vLyBMb2FkaW5nIGxvY2FsU3RvcmFnZSBtb2R1bGVcbmlmICh0eXBlb2YgZ2xvYmFsLmxvY2FsU3RvcmFnZSA9PT0gXCJ1bmRlZmluZWRcIiB8fCBnbG9iYWwubG9jYWxTdG9yYWdlID09PSBudWxsKVxuICAgIGdsb2JhbC5sb2NhbFN0b3JhZ2UgPSBuZXcgKHJlcXVpcmUoJ25vZGUtbG9jYWxzdG9yYWdlJykuTG9jYWxTdG9yYWdlKSgnLi9zdG9yZS9sb2NhbFN0b3JhZ2UnKTtcblxuc2V0Q3J5cHRvU3RvcmVGYWN0b3J5KCgpID0+IG5ldyBMb2NhbFN0b3JhZ2VDcnlwdG9TdG9yZShnbG9iYWwubG9jYWxTdG9yYWdlKSk7XG5cbmFyZ3Yub3B0aW9uKFtcbiAgICB7XG4gICAgICAgIG5hbWU6ICd1cmwnLFxuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdUaGUgVVJMIHRvIGJlIHVzZWQgdG8gY29ubmVjdCB0byB0aGUgTWF0cml4IEhTJyxcbiAgICB9LCB7XG4gICAgICAgIG5hbWU6ICd1c2VybmFtZScsXG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1RoZSB1c2VybmFtZSB0byBiZSB1c2VkIHRvIGNvbm5lY3QgdG8gdGhlIE1hdHJpeCBIUycsXG4gICAgfSwge1xuICAgICAgICBuYW1lOiAncGFzc3dvcmQnLFxuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdUaGUgcGFzc3dvcmQgdG8gYmUgdXNlZCB0byBjb25uZWN0IHRvIHRoZSBNYXRyaXggSFMnLFxuICAgIH0sIHtcbiAgICAgICAgbmFtZTogJ3BvcnQnLFxuICAgICAgICB0eXBlOiAnaW50JyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdQb3J0IHRvIGJpbmQgdG8gKGRlZmF1bHQgODAwMCknLFxuICAgIH1cbl0pO1xuXG5jb25zdCBsb2dnZXIgPSBuZXcgd2luc3Rvbi5Mb2dnZXIoe1xuICAgIGxldmVsOiAnaW5mbycsXG4gICAgdHJhbnNwb3J0czogW1xuICAgICAgICBuZXcgd2luc3Rvbi50cmFuc3BvcnRzLkNvbnNvbGUoe2NvbG9yaXplOiB0cnVlfSlcbiAgICBdXG59KTtcblxuY2xhc3MgQmxldmVIdHRwIHtcbiAgICByZXF1ZXN0OiBSZXF1ZXN0QVBJPFJlcXVlc3RQcm9taXNlLCBSZXF1ZXN0UHJvbWlzZU9wdGlvbnMsIFJlcXVpcmVkVXJpVXJsPjtcblxuICAgIGNvbnN0cnVjdG9yKGJhc2VVcmw6IHN0cmluZykge1xuICAgICAgICB0aGlzLnJlcXVlc3QgPSByZXF1ZXN0LmRlZmF1bHRzKHtiYXNlVXJsfSk7XG4gICAgfVxuXG4gICAgZW5xdWV1ZShldmVudHM6IEFycmF5PEV2ZW50Pikge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KHtcbiAgICAgICAgICAgIHVybDogJ2VucXVldWUnLFxuICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgICBqc29uOiB0cnVlLFxuICAgICAgICAgICAgYm9keTogZXZlbnRzLFxuICAgICAgICB9KTtcbiAgICB9XG59XG5cbmNvbnN0IGIgPSBuZXcgQmxldmVIdHRwKFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwL2FwaS9cIik7XG5cbmZ1bmN0aW9uIGluZGV4YWJsZShldjogRXZlbnQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gaW5kZXhhYmxlS2V5cy5zb21lKChrZXk6IHN0cmluZykgPT4gZ2V0KGV2LCBrZXkpICE9PSB1bmRlZmluZWQpO1xufVxuXG5jb25zdCBxID0gbmV3IFF1ZXVlKGFzeW5jIChiYXRjaDogQXJyYXk8RXZlbnQ+LCBjYikgPT4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNiKG51bGwsIGF3YWl0IGIuZW5xdWV1ZShiYXRjaCkpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY2IoZSk7XG4gICAgfVxufSwge1xuICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgIG1heFJldHJpZXM6IDEwMCxcbiAgICByZXRyeURlbGF5OiA1MDAwLFxuICAgIHN0b3JlOiBuZXcgU3FsaXRlU3RvcmUoe1xuICAgICAgICBwYXRoOiAnLi9zdG9yZS9xdWV1ZS5zcWxpdGUnLFxuICAgIH0pLFxufSk7XG5cbnEub24oJ3Rhc2tfcXVldWVkJywgZnVuY3Rpb24odGFza19pZDogc3RyaW5nLCBldjogRXZlbnQpIHtcbiAgICBjb25zdCB7cm9vbV9pZCwgZXZlbnRfaWQsIHNlbmRlciwgdHlwZX0gPSBldjtcbiAgICBpZiAoZXYucmVkYWN0cykge1xuICAgICAgICBsb2dnZXIuaW5mbygnZW5xdWV1ZSBldmVudCBmb3IgcmVkYWN0aW9uJywge3Jvb21faWQsIGV2ZW50X2lkLCB0YXNrX2lkfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbG9nZ2VyLmluZm8oJ2VucXVldWUgZXZlbnQgZm9yIGluZGV4aW5nJywge3Jvb21faWQsIGV2ZW50X2lkLCBzZW5kZXIsIHR5cGUsIHRhc2tfaWR9KTtcbiAgICB9XG59KTtcblxucS5vbignYmF0Y2hfZmFpbGVkJywgZnVuY3Rpb24oZXJyb3IpIHtcbiAgICBsb2dnZXIuZXJyb3IoJ2JhdGNoIGZhaWxlZCcsIHtlcnJvcn0pO1xufSk7XG5cbnNldHVwKCkudGhlbigpO1xuXG4vLyBkZWJ1ZyBkaXNhYmxlIGpzLXNkayBsb2cgc3BhbVxuY29uc3QgZGlzYWJsZUNvbnNvbGVMb2dnZXIgPSBmYWxzZTtcbmlmIChkaXNhYmxlQ29uc29sZUxvZ2dlcikge1xuICAgIGNvbnNvbGUubG9nID0gZnVuY3Rpb24oKXt9O1xuICAgIGNvbnNvbGUud2FybiA9IGZ1bmN0aW9uKCl7fTtcbiAgICBjb25zb2xlLmVycm9yID0gZnVuY3Rpb24oKXt9O1xuICAgIGNvbnNvbGUuZXJyb3IgPSBmdW5jdGlvbigpe307XG59XG5cbmNvbnN0IEZJTFRFUl9CTE9DSyA9IHtcbiAgICBub3RfdHlwZXM6IFsnKiddLFxuICAgIGxpbWl0OiAwLFxufTtcblxuYXN5bmMgZnVuY3Rpb24gc2V0dXAoKSB7XG4gICAgY29uc3QgYXJncyA9IGFyZ3YucnVuKCk7XG5cbiAgICBjb25zdCBiYXNlVXJsID0gYXJncy5vcHRpb25zWyd1cmwnXSB8fCAnaHR0cHM6Ly9tYXRyaXgub3JnJztcblxuICAgIGxldCBjcmVkcyA9IHtcbiAgICAgICAgdXNlcklkOiBnbG9iYWwubG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3VzZXJJZCcpLFxuICAgICAgICBkZXZpY2VJZDogZ2xvYmFsLmxvY2FsU3RvcmFnZS5nZXRJdGVtKCdkZXZpY2VJZCcpLFxuICAgICAgICBhY2Nlc3NUb2tlbjogZ2xvYmFsLmxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhY2Nlc3NUb2tlbicpLFxuICAgIH07XG5cbiAgICBpZiAoIWNyZWRzLnVzZXJJZCB8fCAhY3JlZHMuZGV2aWNlSWQgfHwgIWNyZWRzLmFjY2Vzc1Rva2VuKSB7XG4gICAgICAgIGlmICghYXJncy5vcHRpb25zWyd1c2VybmFtZSddIHx8ICFhcmdzLm9wdGlvbnNbJ3Bhc3N3b3JkJ10pIHtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcigndXNlcm5hbWUgYW5kIHBhc3N3b3JkIHdlcmUgbm90IHNwZWNpZmllZCBvbiB0aGUgY29tbWFuZGxpbmUgYW5kIG5vbmUgd2VyZSBzYXZlZCcpO1xuICAgICAgICAgICAgYXJndi5oZWxwKCk7XG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoLTEpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbG9naW5DbGllbnQ6IE1hdHJpeENsaWVudCA9IGNyZWF0ZUNsaWVudCh7YmFzZVVybH0pO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBsb2dpbkNsaWVudC5sb2dpbignbS5sb2dpbi5wYXNzd29yZCcsIHtcbiAgICAgICAgICAgICAgICB1c2VyOiBhcmdzLm9wdGlvbnNbJ3VzZXJuYW1lJ10sXG4gICAgICAgICAgICAgICAgcGFzc3dvcmQ6IGFyZ3Mub3B0aW9uc1sncGFzc3dvcmQnXSxcbiAgICAgICAgICAgICAgICBpbml0aWFsX2RldmljZV9kaXNwbGF5X25hbWU6ICdNYXRyaXggU2VhcmNoIERhZW1vbicsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbG9nZ2VyLmluZm8oJ2xvZ2dlZCBpbicsIHt1c2VyX2lkOiByZXMudXNlcl9pZH0pO1xuICAgICAgICAgICAgZ2xvYmFsLmxvY2FsU3RvcmFnZS5zZXRJdGVtKCd1c2VySWQnLCByZXMudXNlcl9pZCk7XG4gICAgICAgICAgICBnbG9iYWwubG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2RldmljZUlkJywgcmVzLmRldmljZV9pZCk7XG4gICAgICAgICAgICBnbG9iYWwubG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2FjY2Vzc1Rva2VuJywgcmVzLmFjY2Vzc190b2tlbik7XG5cbiAgICAgICAgICAgIGNyZWRzID0ge1xuICAgICAgICAgICAgICAgIHVzZXJJZDogcmVzLnVzZXJfaWQsXG4gICAgICAgICAgICAgICAgZGV2aWNlSWQ6IHJlcy5kZXZpY2VfaWQsXG4gICAgICAgICAgICAgICAgYWNjZXNzVG9rZW46IHJlcy5hY2Nlc3NfdG9rZW4sXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbG9nZ2VyLmVycm9yKCdhbiBlcnJvciBvY2N1cnJlZCBsb2dnaW5nIGluJywge2Vycm9yfSk7XG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBjbGk6IE1hdHJpeENsaWVudCA9IGNyZWF0ZUNsaWVudCh7XG4gICAgICAgIGJhc2VVcmwsXG4gICAgICAgIGlkQmFzZVVybDogJycsXG4gICAgICAgIC4uLmNyZWRzLFxuICAgICAgICB1c2VBdXRob3JpemF0aW9uSGVhZGVyOiB0cnVlLFxuICAgICAgICBzdG9yZTogbmV3IE1hdHJpeEluTWVtb3J5U3RvcmUoe1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlOiBnbG9iYWwubG9jYWxTdG9yYWdlLFxuICAgICAgICB9KSxcbiAgICAgICAgc2Vzc2lvblN0b3JlOiBuZXcgV2ViU3RvcmFnZVNlc3Npb25TdG9yZShnbG9iYWwubG9jYWxTdG9yYWdlKSxcbiAgICB9KTtcblxuICAgIGNsaS5vbignZXZlbnQnLCAoZXZlbnQ6IE1hdHJpeEV2ZW50KSA9PiB7XG4gICAgICAgIGlmIChldmVudC5pc0VuY3J5cHRlZCgpKSByZXR1cm47XG5cbiAgICAgICAgY29uc3QgY2V2ID0gZXZlbnQuZ2V0Q2xlYXJFdmVudCgpO1xuICAgICAgICAvLyBpZiBldmVudCBjYW4gYmUgcmVkYWN0ZWQgb3IgaXMgYSByZWRhY3Rpb24gdGhlbiBlbnF1ZXVlIGl0IGZvciBwcm9jZXNzaW5nXG4gICAgICAgIGlmIChldmVudC5nZXRUeXBlKCkgPT09IFwibS5yb29tLnJlZGFjdGlvblwiIHx8ICFpbmRleGFibGUoY2V2KSkgcmV0dXJuO1xuICAgICAgICByZXR1cm4gcS5wdXNoKGNldik7XG4gICAgfSk7XG4gICAgY2xpLm9uKCdFdmVudC5kZWNyeXB0ZWQnLCAoZXZlbnQ6IE1hdHJpeEV2ZW50KSA9PiB7XG4gICAgICAgIGlmIChldmVudC5pc0RlY3J5cHRpb25GYWlsdXJlKCkpIHtcbiAgICAgICAgICAgIGxvZ2dlci53YXJuKCdkZWNyeXB0aW9uIGZhaWx1cmUnLCB7ZXZlbnQ6IGV2ZW50LmV2ZW50fSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjZXYgPSBldmVudC5nZXRDbGVhckV2ZW50KCk7XG4gICAgICAgIGlmICghaW5kZXhhYmxlKGNldikpIHJldHVybjtcbiAgICAgICAgcmV0dXJuIHEucHVzaChjZXYpO1xuICAgIH0pO1xuXG4gICAgLy8gY2xpLm9uKCdSb29tLnJlZGFjdGlvbicsIChldmVudDogTWF0cml4RXZlbnQpID0+IHtcbiAgICAvLyAgICAgcmV0dXJuIHEucHVzaCh7XG4gICAgLy8gICAgICAgICB0eXBlOiBKb2JUeXBlLnJlZGFjdCxcbiAgICAvLyAgICAgICAgIGV2ZW50OiBldmVudC5nZXRDbGVhckV2ZW50KCksXG4gICAgLy8gICAgIH0pO1xuICAgIC8vIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgbG9nZ2VyLmluZm8oJ2luaXRpYWxpemluZyBjcnlwdG8nKTtcbiAgICAgICAgYXdhaXQgY2xpLmluaXRDcnlwdG8oKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ2ZhaWxlZCB0byBpbml0IGNyeXB0bycsIHtlcnJvcn0pO1xuICAgICAgICBwcm9jZXNzLmV4aXQoLTEpO1xuICAgIH1cbiAgICBsb2dnZXIuaW5mbygnY3J5cHRvIGluaXRpYWxpemVkJyk7XG5cbiAgICAvLyBjcmVhdGUgc3luYyBmaWx0ZXJcbiAgICBjb25zdCBmaWx0ZXIgPSBuZXcgRmlsdGVyKGNsaS5jcmVkZW50aWFscy51c2VySWQpO1xuICAgIGZpbHRlci5zZXREZWZpbml0aW9uKHtcbiAgICAgICAgcm9vbToge1xuICAgICAgICAgICAgaW5jbHVkZV9sZWF2ZTogZmFsc2UsIC8vIFRPRE86IG5vdCBzdXJlIGhlcmVcbiAgICAgICAgICAgIC8vIGVwaGVtZXJhbDogRklMVEVSX0JMT0NLLCAvLyB3ZSBkb24ndCBjYXJlIGFib3V0IGVwaGVtZXJhbCBldmVudHNcbiAgICAgICAgICAgIGFjY291bnRfZGF0YTogRklMVEVSX0JMT0NLLCAvLyB3ZSBkb24ndCBjYXJlIGFib3V0IHJvb20gYWNjb3VudF9kYXRhXG4gICAgICAgICAgICAvLyBzdGF0ZTogRklMVEVSX0JMT0NLLCAvLyBUT0RPOiBkbyB3ZSBjYXJlIGFib3V0IHN0YXRlXG4gICAgICAgICAgICB0aW1lbGluZTogeyAvLyBUT0RPIGRvIHdlIHdhbnQgYWxsIHRpbWVsaW5lIGV2c1xuICAgICAgICAgICAgICAgIGxpbWl0OiAyMCwgLy8gZ3JhYiBtb3JlIGV2ZW50cyBmb3IgZWFjaCByb29tIHRvIGJlZ2luIHdpdGhcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHByZXNlbmNlOiBGSUxURVJfQkxPQ0ssIC8vIHdlIGRvbid0IGNhcmUgYWJvdXQgcHJlc2VuY2VcbiAgICAgICAgYWNjb3VudF9kYXRhOiBGSUxURVJfQkxPQ0ssIC8vIHdlIGRvbid0IGNhcmUgYWJvdXQgZ2xvYmFsIGFjY291bnRfZGF0YVxuICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgbG9nZ2VyLmluZm8oJ2xvYWRpbmcvY3JlYXRpbmcgc3luYyBmaWx0ZXInKTtcbiAgICAgICAgZmlsdGVyLmZpbHRlcklkID0gYXdhaXQgY2xpLmdldE9yQ3JlYXRlRmlsdGVyKGZpbHRlck5hbWUoY2xpKSwgZmlsdGVyKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ2ZhaWxlZCB0byBnZXRPckNyZWF0ZSBzeW5jIGZpbHRlcicsIHtlcnJvcn0pO1xuICAgICAgICBwcm9jZXNzLmV4aXQoLTEpO1xuICAgIH1cbiAgICBsb2dnZXIuaW5mbygnc3luYyBmaWx0ZXIgbG9hZGVkJywge2ZpbHRlcl9pZDogZmlsdGVyLmdldEZpbHRlcklkKCl9KTtcblxuICAgIGxvZ2dlci5pbmZvKCdzdGFydGluZyBjbGllbnQnKTtcbiAgICAvLyBmaWx0ZXIgc3luYyB0byBpbXByb3ZlIHBlcmZvcm1hbmNlXG4gICAgY2xpLnN0YXJ0Q2xpZW50KHtcbiAgICAgICAgZGlzYWJsZVByZXNlbmNlOiB0cnVlLFxuICAgICAgICBmaWx0ZXIsXG4gICAgfSk7XG4gICAgbG9nZ2VyLmluZm8oJ2NsaWVudCBzdGFydGVkIC0gZmV0Y2hlciBoYXMgYmVndW4nKTtcbn1cblxuLy8gVE9ETyBncm91cHMtcGFnaW5hdGlvblxuLy8gVE9ETyBiYWNrZmlsbFxuLy8gVE9ETyBnYXBmaWxsXG5cbmZ1bmN0aW9uIGZpbHRlck5hbWUoY2xpOiBNYXRyaXhDbGllbnQpOiBzdHJpbmcge1xuICAgIHJldHVybiBgTUFUUklYX1NFQVJDSF9GSUxURVJfJHtjbGkuY3JlZGVudGlhbHMudXNlcklkfWA7XG59XG5cbmVudW0gUmVxdWVzdEtleSB7XG4gICAgYm9keSA9IFwiY29udGVudC5ib2R5XCIsXG4gICAgbmFtZSA9IFwiY29udGVudC5uYW1lXCIsXG4gICAgdG9waWMgPSBcImNvbnRlbnQudG9waWNcIixcbn1cblxuY29uc3QgaW5kZXhhYmxlS2V5cyA9IFtSZXF1ZXN0S2V5LmJvZHksIFJlcXVlc3RLZXkubmFtZSwgUmVxdWVzdEtleS50b3BpY107XG4iXX0=