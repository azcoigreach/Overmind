'use strict';

// Exercise the production TypeScript with a small mocked Screeps runtime.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const _ = require('lodash');

function load(relativePath, globals = {}, imports = {}) {
    const filename = path.join(__dirname, '..', relativePath);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2017,
            experimentalDecorators: true,
        },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, Object.assign({
        exports, _, console, global: {},
        require(name) {
            if (name.endsWith('/profiler/decorator')) return {profile() {}};
            if (Object.prototype.hasOwnProperty.call(imports, name)) return imports[name];
            throw new Error(`Unexpected import ${name} from ${relativePath}`);
        },
    }, globals), {filename});
    return exports;
}

function pathingFixture() {
    let routeCalls = 0;
    let searchCalls = 0;
    const warnings = [];
    const alerts = [];
    const Game = {
        time: 100, rooms: {},
        map: {
            getRoomLinearDistance: (a, b) => a === b ? 0 : 6,
            findRoute() { routeCalls++; return -2; },
        },
    };
    const Memory = {rooms: {}, pathing: {distances: {}}};
    const PathFinder = {search() {
        searchCalls++;
        return {path: [], ops: 10, cost: 0, incomplete: true};
    }};
    const {Pathing} = load('src/movement/Pathing.ts', {Game, Memory, PathFinder, _RM: {AVOID: 'avoid'}}, {
        '../caching/GlobalCache': {},
        '../console/log': {log: {warning: message => warnings.push(message), alert: message => alerts.push(message)}},
        '../declarations/typeGuards': {},
        '../utilities/Cartographer': {Cartographer: {roomType: () => 'normal'}},
        '../visuals/Visualizer': {},
        './helpers': {},
    });
    const origin = {roomName: 'W55N18', name: 'W55N18:25:25', print: '[W55N18,25,25]'};
    const destination = {roomName: 'W56N12', name: 'W56N12:24:39', print: '[W56N12,24,39]'};
    return {Pathing, Game, Memory, PathFinder, origin, destination, warnings, alerts,
        routeCalls: () => routeCalls, searchCalls: () => searchCalls};
}

let passed = 0;
function test(name, callback) {
    callback();
    passed++;
    console.log(`PASS ${name}`);
}

test('unreachable room routes skip tile searches and retry after 25 ticks', () => {
    const f = pathingFixture();
    for (let tick = 100; tick < 125; tick++) {
        f.Game.time = tick;
        const result = f.Pathing.findPath(f.origin, f.destination);
        assert.strictEqual(result.incomplete, true);
        assert.strictEqual(result.path.length, 0);
    }
    assert.strictEqual(f.routeCalls(), 1);
    assert.strictEqual(f.searchCalls(), 0);
    assert.strictEqual(f.warnings.length, 1);
    f.Game.time = 125;
    f.Pathing.findPath(f.origin, f.destination);
    assert.strictEqual(f.routeCalls(), 2);
});

test('nearby ensurePath requests check the route before spending tile-search CPU', () => {
    const f = pathingFixture();
    f.Game.map.getRoomLinearDistance = () => 1;
    f.Pathing.findPath(f.origin, f.destination, {ensurePath: true});
    assert.strictEqual(f.routeCalls(), 1);
    assert.strictEqual(f.searchCalls(), 0);
});

test('route failure cache respects travel policy and direction', () => {
    const f = pathingFixture();
    f.Pathing.findRoute('W55N18', 'W56N12');
    f.Pathing.findRoute('W55N18', 'W56N12', {allowHostile: true});
    f.Pathing.findRoute('W55N18', 'W56N12', {restrictDistance: 30});
    f.Pathing.findRoute('W55N18', 'W56N12', {preferHighway: true});
    f.Pathing.findRoute('W56N12', 'W55N18');
    assert.strictEqual(f.routeCalls(), 5);
});

test('routes can recover after expiry without relaxing hostile-room avoidance', () => {
    const f = pathingFixture();
    f.Pathing.findPath(f.origin, f.destination);
    f.Memory.rooms.W55N17 = {avoid: true};
    f.Game.time += 25;
    f.Game.map.findRoute = (origin, destination, options) => {
        assert.strictEqual(options.routeCallback('W55N17'), Infinity);
        assert.strictEqual(options.routeCallback(origin), 1);
        assert.strictEqual(options.routeCallback(destination), 1);
        return [{room: 'W54N18'}, {room: destination}];
    };
    f.PathFinder.search = (origin, destination, options) => {
        assert.strictEqual(options.roomCallback('W55N17'), false);
        return {path: [f.destination], ops: 10, cost: 1, incomplete: false};
    };
    assert.strictEqual(f.Pathing.findPath(f.origin, f.destination).incomplete, false);
});

test('explicit routes and useFindRoute:false retain caller control', () => {
    const f = pathingFixture();
    f.Pathing.findRoute(f.origin.roomName, f.destination.roomName);
    f.Pathing.findPath(f.origin, f.destination, {useFindRoute: false, ensurePath: true});
    f.Pathing.findPath(f.origin, f.destination, {route: {[f.origin.roomName]: true, [f.destination.roomName]: true}});
    assert.strictEqual(f.routeCalls(), 1);
    assert.strictEqual(f.searchCalls(), 2);
});

test('same-room ensurePath does not need a map route', () => {
    const f = pathingFixture();
    f.Pathing.findPath(f.origin, f.origin, {ensurePath: true});
    assert.strictEqual(f.routeCalls(), 0);
    assert.strictEqual(f.searchCalls(), 1);
});

test('failed distance estimates are retried, never cached as valid partial lengths', () => {
    const f = pathingFixture();
    assert.strictEqual(f.Pathing.distance(f.origin, f.destination), undefined);
    assert.strictEqual(f.Pathing.distance(f.destination, f.origin), undefined);
    f.Game.time += 24;
    assert.strictEqual(f.Pathing.distance(f.origin, f.destination), undefined);
    assert.strictEqual(f.alerts.length, 1);
    f.Game.time++;
    f.Game.map.findRoute = () => [{room: f.destination.roomName}];
    f.PathFinder.search = () => ({path: [f.destination], ops: 1, cost: 1, incomplete: false});
    assert.strictEqual(f.Pathing.distance(f.origin, f.destination), 1);
    assert.strictEqual(f.Pathing.distance(f.destination, f.origin), 1);
});

test('zero-length successful distances remain cached', () => {
    const f = pathingFixture();
    f.PathFinder.search = () => ({path: [], ops: 0, cost: 0, incomplete: false});
    assert.strictEqual(f.Pathing.distance(f.origin, f.origin), 0);
    f.PathFinder.search = () => { throw new Error('Should reuse zero distance'); };
    assert.strictEqual(f.Pathing.distance(f.origin, f.origin), 0);
});

const bodyGlobals = {MAX_CREEP_SIZE: 50, BODYPART_COST: {
    move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, heal: 250, claim: 600, tough: 10,
}};
Object.keys(bodyGlobals.BODYPART_COST).forEach(part => { bodyGlobals[part.toUpperCase()] = part; });
const bodyModule = load('src/creepSetups/CreepSetup.ts', bodyGlobals);
const setups = load('src/creepSetups/setups.ts', bodyGlobals, {'./CreepSetup': bodyModule});
const {OutpostDefenseOverlord} = load('src/overlords/defense/outpostDefense.ts', bodyGlobals, {
    '../../creepSetups/CreepSetup': bodyModule,
    '../../creepSetups/setups': setups,
    '../../intel/CombatIntel': {CombatIntel: {isHealer: () => false}},
    '../../priorities/priorities_overlords': {},
    '../CombatOverlord': {CombatOverlord: class {}},
    '../Overlord': {MAX_SPAWN_REQUESTS: 100},
});

function defenderRequests(capacity, colonyCapacity = 300, enemy = {attack: 10, rangedAttack: 3, heal: 0}) {
    const overlord = Object.create(OutpostDefenseOverlord.prototype);
    Object.assign(overlord, {spawnGroup: {energyCapacityAvailable: capacity},
        colony: {room: {energyCapacityAvailable: colonyCapacity}}, priority: 1});
    overlord.getEnemyPotentials = () => enemy;
    const requests = [];
    overlord.wishlist = (quantity, setup) => requests.push({quantity, setup});
    overlord.init();
    requests.forEach(({quantity, setup}) => {
        assert(Number.isFinite(quantity));
        assert(quantity >= 0 && quantity <= 100);
        if (quantity > 0) {
            const body = setup.generateBody(capacity);
            assert(body.length > 0);
            assert(bodyModule.bodyCost(body) <= capacity);
        }
    });
    return requests;
}

test('unavailable or unaffordable defenders never cause infinite spawn requests', () => {
    for (const capacity of [0, 100, 130, 200, 300, 550, 800, 900, 1800]) {
        defenderRequests(capacity, 3000);
    }
    assert(defenderRequests(0).every(request => request.quantity === 0));
    assert.strictEqual(defenderRequests(200)[2].quantity, 0);
});

test('defender mode and strength use the actual spawn group, in both energy directions', () => {
    const strong = defenderRequests(1800, 300);
    assert.strictEqual(strong[1].setup, setups.CombatSetups.broodlings.default);
    assert.strictEqual(strong[1].quantity, 3); // 6 ATTACK parts, ceil(1.5 * 10 / 6)
    const weak = defenderRequests(300, 3000);
    assert.strictEqual(weak[1].setup, setups.CombatSetups.broodlings.early);
    assert.strictEqual(weak[1].quantity, 8); // 2 ATTACK parts, ceil(1.5 * 10 / 2)
    assert.strictEqual(weak[2].quantity, 1);
});

test('zero or invalid enemy potential produces finite zero requests; large threats are bounded', () => {
    for (const amount of [0, NaN, Infinity, -1]) {
        assert(defenderRequests(1800, 300, {attack: amount, rangedAttack: amount, heal: amount})
            .every(request => request.quantity === 0));
    }
    assert.strictEqual(defenderRequests(300, 300, {attack: 10000, rangedAttack: 0, heal: 0})[1].quantity, 100);
});

function spawnGroupFixture(rooms, reachable) {
    const Game = {time: 100, rooms: _.indexBy(rooms, 'name'), map: {getRoomLinearDistance: () => 2}};
    const Memory = {rooms: {}};
    const paths = [];
    const {SpawnGroup} = load('src/logistics/SpawnGroup.ts', {Game, Memory, Overmind: {spawnGroups: {}}}, {
        '../console/log': {log: {warning() {}}},
        '../creepSetups/CreepSetup': bodyModule,
        '../memory/Memory': {Mem: {wrap(parent, key, defaults) {
            if (!parent[key]) parent[key] = _.cloneDeep(defaults);
            return parent[key];
        }}},
        '../movement/Pathing': {Pathing: {
            findRoute(origin, destination) {
                return reachable.includes(origin) ? {[origin]: true, [destination]: true} : undefined;
            },
            findPathToRoom(origin, destination, options) {
                assert(options.route, 'Never search tiles after a failed room route');
                paths.push(origin.roomName);
                return {path: Array(50).fill(null), incomplete: false};
            },
        }},
        '../utilities/utils': {
            onPublicServer: () => true,
            getAllColonyRooms: () => rooms,
            getCacheExpiration: timeout => Game.time + timeout,
        },
    });
    const group = new SpawnGroup({ref: 'defense', pos: {roomName: 'W56N12'}}, {requiredRCL: 1});
    return {group, paths};
}

test('empty spawn groups expose zero energy instead of negative infinity', () => {
    const {group} = spawnGroupFixture([], []);
    assert.strictEqual(group.energyCapacityAvailable, 0);
    assert.strictEqual(group.colonyNames.length, 0);
});

test('spawn groups skip unreachable colonies before tile search and body sizing', () => {
    const rooms = ['W55N18', 'W56N13'].map((name, index) => ({
        name, my: true, controller: {level: 8}, energyCapacityAvailable: index === 0 ? 3000 : 1300,
        spawns: [{pos: {roomName: name}}],
    }));
    const {group, paths} = spawnGroupFixture(rooms, ['W56N13']);
    assert.deepStrictEqual(paths, ['W56N13']);
    assert.strictEqual(group.energyCapacityAvailable, 1300);
    assert.strictEqual(group.colonyNames.length, 1);
    assert.strictEqual(group.colonyNames[0], 'W56N13');
});

console.log(`${passed} regression tests passed.`);
