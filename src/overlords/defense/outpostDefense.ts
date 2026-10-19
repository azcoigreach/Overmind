import {CreepSetup, patternCost} from '../../creepSetups/CreepSetup';
import {CombatSetups, Roles} from '../../creepSetups/setups';
import {DirectiveOutpostDefense} from '../../directives/defense/outpostDefense';
import {CombatIntel} from '../../intel/CombatIntel';
import {Movement} from '../../movement/Movement';
import {OverlordPriority} from '../../priorities/priorities_overlords';
import {profile} from '../../profiler/decorator';
import {minBy} from '../../utilities/utils';
import {CombatZerg} from '../../zerg/CombatZerg';
import {CombatOverlord} from '../CombatOverlord';
import {getOverlord, MAX_SPAWN_REQUESTS, setOverlord} from '../Overlord';

const FIGHTER_ROLES = [Roles.guardMelee, Roles.ranged];

/**
 * General purpose skirmishing overlord for dealing with player combat in an outpost
 */
@profile
export class OutpostDefenseOverlord extends CombatOverlord {

	broodlings: CombatZerg[];
	hydralisks: CombatZerg[];
	healers: CombatZerg[];

	constructor(directive: DirectiveOutpostDefense, priority = OverlordPriority.outpostDefense.outpostDefense) {
		super(directive, 'outpostDefense', priority, 1);
		this.spawnGroup.settings.flexibleEnergy = true;
		this.broodlings = this.combatZerg(Roles.guardMelee);
		this.hydralisks = this.combatZerg(Roles.ranged);
		this.healers = this.combatZerg(Roles.healer);
	}

	private static _active: { tick: number, overlords: OutpostDefenseOverlord[] } | undefined;

	private get targets(): Creep[] {
		return this.room ? _.filter(this.room.hostiles, hostile => hostile.owner.username != 'Source Keeper') : [];
	}

	private static activeDefenses(): OutpostDefenseOverlord[] {
		if (!this._active || this._active.tick != Game.time) {
			const overlords = _.filter(_.values(Overmind.overlords), (overlord: any) =>
				overlord instanceof OutpostDefenseOverlord && overlord.targets.length > 0) as OutpostDefenseOverlord[];
			this._active = {tick: Game.time, overlords};
		}
		return this._active.overlords;
	}

	private roomDistance(creep: { pos: RoomPosition }): number {
		return Game.map.getRoomLinearDistance(creep.pos.roomName, this.pos.roomName);
	}

	private static closestActiveDefense(creep: { pos: RoomPosition }): OutpostDefenseOverlord | undefined {
		return minBy(this.activeDefenses(), overlord => overlord.roomDistance(creep));
	}

	/**
	 * Idle fighters (e.g. orphaned when their guard directive expired) join whichever active defense is closest
	 */
	private adoptIdleFighters(): void {
		const idle = _.filter(Game.creeps, creep => _.contains(FIGHTER_ROLES, creep.memory.role) && !getOverlord(creep));
		for (const creep of idle) {
			if (OutpostDefenseOverlord.closestActiveDefense(creep) === this) {
				setOverlord(creep, this);
			}
		}
	}

	/**
	 * Hostiles in the creep's current room if that room is part of our territory, so intruders are intercepted en route
	 */
	private localTargets(zerg: CombatZerg): Creep[] {
		if (zerg.room.name == this.pos.roomName) {
			return this.targets;
		}
		if (!Overmind.colonyMap[zerg.room.name]) {
			return [];
		}
		return _.filter(zerg.room.hostiles, hostile => hostile.owner.username != 'Source Keeper'
													  && hostile.pos.rangeToEdge > 0);
	}

	private canRecover(zerg: CombatZerg): boolean {
		return zerg.getActiveBodyparts(HEAL) > 0 || _.any(this.healers, healer => healer.getActiveBodyparts(HEAL) > 0);
	}

	private handleCombat(zerg: CombatZerg): void {
		const localTargets = this.localTargets(zerg);
		if (localTargets.length > 0) {
			this.engage(zerg, zerg.room.name, localTargets);
			return;
		}
		const closest = OutpostDefenseOverlord.closestActiveDefense(zerg);
		const roomIsClear = !!this.room && this.targets.length == 0;
		if (closest && closest !== this && (roomIsClear || closest.roomDistance(zerg) < this.roomDistance(zerg))) {
			setOverlord(zerg, closest);
			closest.handleCombat(zerg);
			return;
		}
		if (roomIsClear) {
			zerg.doMedicActions(this.pos.roomName);
		} else {
			this.engage(zerg, this.pos.roomName, this.targets);
		}
	}

	/**
	 * Attack every hostile in the room instead of only those the skirmish analysis deems favorable
	 */
	private engage(zerg: CombatZerg, roomName: string, targets: Creep[]): void {
		if (zerg.getActiveBodyparts(ATTACK) > 0) {
			zerg.autoMelee();
		}
		if (zerg.getActiveBodyparts(RANGED_ATTACK) > 0) {
			zerg.autoRanged();
		}
		if (zerg.canExecute('heal')) {
			zerg.autoHeal(zerg.canExecute('rangedHeal'));
		}

		// Without a source of healing, retreating just leaves the room undefended forever
		if (zerg.needsToRecover(0.35, 0.8) && this.canRecover(zerg)) {
			zerg.recover();
			return;
		}

		if (!zerg.safelyInRoom(roomName)) {
			zerg.goToRoom(roomName, {ensurePath: true});
			return;
		}

		const target = zerg.pos.findClosestByRange(targets);
		if (!target) {
			zerg.park();
			return;
		}
		const isMelee = zerg.getActiveBodyparts(ATTACK) > 0;
		const avoid: PathFinderGoal[] = [];
		let range = 1;
		if (!isMelee) {
			for (const hostile of targets) {
				if (hostile.getActiveBodyparts(ATTACK) > 0) {
					avoid.push({pos: hostile.pos, range: 2});
				}
			}
			if (target.getActiveBodyparts(ATTACK) > 0) {
				range = 3;
			}
		}
		Movement.combatMove(zerg, [{pos: target.pos, range: range}], avoid);
	}

	private handleHealer(healer: CombatZerg): void {
		if (CombatIntel.isHealer(healer) && healer.getActiveBodyparts(HEAL) == 0) {
			if (this.colony.towers.length > 0) {
				healer.goToRoom(this.colony.room.name); // go get healed
			} else {
				healer.suicide(); // you're useless at this point // TODO: this isn't smart
			}
		} else {
			if (this.room && _.any([...this.broodlings, ...this.hydralisks], creep => creep.room == this.room)) {
				this.handleCombat(healer); // go to room if there are any fighters in there
			} else {
				healer.autoSkirmish(healer.room.name);
			}
		}
	}

	private computeNeededAmount(setup: CreepSetup, part: BodyPartConstant, enemyPotential: number): number {
		// Size defenders against the same spawn group that will actually build them.
		const body = setup.generateBody(this.spawnGroup.energyCapacityAvailable);
		const potential = _.filter(body, bodyPart => bodyPart == part).length;
		if (potential == 0 || !Number.isFinite(enemyPotential) || enemyPotential <= 0) return 0;
		return Math.min(MAX_SPAWN_REQUESTS, Math.ceil(1.5 * enemyPotential / potential));
	}

	private getEnemyPotentials(): { attack: number, rangedAttack: number, heal: number } {
		if (this.room) {
			return CombatIntel.getCombatPotentials(this.room.hostiles);
		} else {
			return {attack: 1, rangedAttack: 0, heal: 0,};
		}
	}

	init() {

		const maxCost = Math.max(patternCost(CombatSetups.hydralisks.default),
								 patternCost(CombatSetups.broodlings.default));
		const energyCapacity = this.spawnGroup.energyCapacityAvailable;
		const mode = energyCapacity >= maxCost ? 'NORMAL' : 'EARLY';

		const {attack, rangedAttack, heal} = this.getEnemyPotentials();

		if (this.room && this.targets.length > 0) {
			this.adoptIdleFighters();
		}

		const hydraliskSetup = mode == 'NORMAL' ? CombatSetups.hydralisks.default : CombatSetups.hydralisks.early;
		let hydraliskAmount = this.computeNeededAmount(hydraliskSetup, RANGED_ATTACK, rangedAttack);
		// Non-combat intruders (e.g. remote miners) still need someone to chase them off
		if (this.room && this.targets.length > 0) {
			hydraliskAmount = Math.max(hydraliskAmount, 1);
		}
		this.wishlist(hydraliskAmount, hydraliskSetup, {priority: this.priority - .2});

		const broodlingSetup = mode == 'NORMAL' ? CombatSetups.broodlings.default : CombatSetups.broodlings.early;
		const broodlingAmount = this.computeNeededAmount(broodlingSetup, ATTACK, attack);
		this.wishlist(broodlingAmount, broodlingSetup, {priority: this.priority - .1});

		const enemyHealers = _.filter(this.room ? this.room.hostiles : [], creep => CombatIntel.isHealer(creep)).length;
		let healerAmount = (enemyHealers > 0 || mode == 'EARLY') ?
						   this.computeNeededAmount(CombatSetups.healers.default, HEAL, heal) : 0;
		if (mode == 'EARLY' && attack + rangedAttack > 0 &&
			energyCapacity >= patternCost(CombatSetups.healers.default)) {
			healerAmount = Math.max(healerAmount, 1);
		}
		this.wishlist(healerAmount, CombatSetups.healers.default, {priority: this.priority, reassignIdle: true});

	}

	run() {
		// Copies, since handleCombat can reassign creeps and mutate these arrays mid-iteration
		this.autoRun([...this.broodlings], broodling => this.handleCombat(broodling));
		this.autoRun([...this.hydralisks], hydralisk => this.handleCombat(hydralisk));
		this.autoRun([...this.healers], healer => this.handleHealer(healer));
	}
}
