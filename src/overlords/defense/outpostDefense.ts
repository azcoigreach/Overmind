import {CreepSetup, patternCost} from '../../creepSetups/CreepSetup';
import {CombatSetups, Roles} from '../../creepSetups/setups';
import {DirectiveOutpostDefense} from '../../directives/defense/outpostDefense';
import {CombatIntel} from '../../intel/CombatIntel';
import {OverlordPriority} from '../../priorities/priorities_overlords';
import {profile} from '../../profiler/decorator';
import {CombatZerg} from '../../zerg/CombatZerg';
import {CombatOverlord} from '../CombatOverlord';
import {MAX_SPAWN_REQUESTS} from '../Overlord';

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

	private handleCombat(zerg: CombatZerg): void {
		if (this.room && this.room.hostiles.length == 0) {
			zerg.doMedicActions(this.room.name);
		} else {
			zerg.autoSkirmish(this.pos.roomName);
		}
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

		const hydraliskSetup = mode == 'NORMAL' ? CombatSetups.hydralisks.default : CombatSetups.hydralisks.early;
		const hydraliskAmount = this.computeNeededAmount(hydraliskSetup, RANGED_ATTACK, rangedAttack);
		this.wishlist(hydraliskAmount, hydraliskSetup, {priority: this.priority - .2, reassignIdle: true});

		const broodlingSetup = mode == 'NORMAL' ? CombatSetups.broodlings.default : CombatSetups.broodlings.early;
		const broodlingAmount = this.computeNeededAmount(broodlingSetup, ATTACK, attack);
		this.wishlist(broodlingAmount, broodlingSetup, {priority: this.priority - .1, reassignIdle: true});

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
		this.autoRun(this.broodlings, broodling => this.handleCombat(broodling));
		this.autoRun(this.hydralisks, mutalisk => this.handleCombat(mutalisk));
		this.autoRun(this.healers, healer => this.handleHealer(healer));
	}
}
