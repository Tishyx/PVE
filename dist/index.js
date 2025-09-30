"use strict";
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
class Ability {
    /**
     * @param {Object} options
     * @param {string} options.id
     * @param {string} options.name
     * @param {string} options.icon
     * @param {string} options.hotkey
     * @param {number} options.energyCost
     * @param {number} options.comboPoints
     * @param {number} options.cooldown
     * @param {boolean} [options.triggersGcd=true]
     * @param {string} options.description
     * @param {(sim: RogueSimulator, ability: Ability) => boolean | void} options.handler
     */
    constructor({ id, name, icon, hotkey, energyCost, comboPoints = 0, cooldown = 0, triggersGcd = true, description, handler }) {
        this.id = id;
        this.name = name;
        this.icon = icon;
        this.hotkey = hotkey;
        this.energyCost = energyCost;
        this.comboPoints = comboPoints;
        this.cooldown = cooldown;
        this.triggersGcd = triggersGcd;
        this.description = description;
        this.handler = handler;
    }
    /**
     * Validate that the ability can be used in the current state.
     * @param {RogueSimulator} sim
     */
    canUse(sim) {
        if (sim.state.energy < this.energyCost) {
            sim.ui.addLogEntry(`${this.name} failed: not enough energy`, 'system');
            return false;
        }
        if (this.triggersGcd && sim.state.globalCooldown > 0) {
            sim.ui.addLogEntry(`${this.name} failed: on global cooldown`, 'system');
            return false;
        }
        if (sim.state.cooldowns.has(this.id)) {
            sim.ui.addLogEntry(`${this.name} failed: ability on cooldown`, 'system');
            return false;
        }
        return true;
    }
    /**
     * Execute the ability handler while deducting energy.
     * @param {RogueSimulator} sim
     */
    execute(sim) {
        sim.spendEnergy(this.energyCost);
        const result = this.handler(sim, this);
        if (result === false) {
            sim.refundEnergy(this.energyCost);
            return;
        }
        if (this.triggersGcd) {
            sim.triggerGlobalCooldown();
        }
        if (this.cooldown > 0) {
            sim.setCooldown(this.id, this.cooldown);
        }
    }
}
class SoundPlayer {
    constructor() {
        this.context = null;
    }
    ensureContext() {
        if (!this.context) {
            // Fix: Handle vendor-prefixed webkitAudioContext for older browsers.
            this.context = new (window.AudioContext || window.webkitAudioContext)();
        }
    }
    playHit() {
        try {
            this.ensureContext();
            const now = this.context.currentTime;
            const osc = this.context.createOscillator();
            const gain = this.context.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(420, now);
            osc.frequency.exponentialRampToValueAtTime(220, now + 0.15);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
            osc.connect(gain).connect(this.context.destination);
            osc.start(now);
            osc.stop(now + 0.22);
        }
        catch (error) {
            console.warn('Audio playback failed', error);
        }
    }
}
const PROC_DEFINITIONS = [
    {
        id: 'energySurge',
        name: 'Energy Surge',
        icon: '⚡',
        description: 'Instantly restores energy on successful strikes.',
        events: ['damage'],
        defaultConfig: { enabled: true, chance: 20, energyGain: 25 },
        fields: [
            { key: 'chance', label: 'Proc Chance (%)', min: 0, max: 100, defaultValue: 20 },
            { key: 'energyGain', label: 'Energy Gain', min: 0, defaultValue: 25 },
        ],
        // Fix: Update condition signature to match call in handleEvent, which passes 3 arguments.
        condition: (context, config, sim) => !context.isDot,
        // Fix: Add optional context parameter to match call signature in handleEvent.
        onTrigger: (sim, config, context) => {
            const energy = Math.max(0, Number(config.energyGain) || 0);
            let log = 'Energy Surge triggered!';
            let floatingText = 'Energy Surge!';
            let floatingType = 'proc';
            if (energy > 0) {
                sim.refillEnergy(energy);
                log = `Energy Surge restores ${energy} energy!`;
                floatingText = `+${energy} Energy`;
                floatingType = 'energy';
            }
            else {
                log = 'Energy Surge triggered but no energy gain is configured.';
            }
            return {
                log,
                floatingText,
                floatingTextType: floatingType,
            };
        },
    },
    {
        id: 'flurryStrike',
        name: 'Flurry Strike',
        icon: '💨',
        description: 'Critical hits grant temporary attack speed.',
        events: ['damage'],
        defaultConfig: { enabled: true, chance: 35, hastePercent: 25, duration: 6 },
        fields: [
            { key: 'chance', label: 'Proc Chance (%)', min: 0, max: 100, defaultValue: 35 },
            { key: 'hastePercent', label: 'Haste Bonus (%)', min: 0, defaultValue: 25 },
            { key: 'duration', label: 'Duration (s)', min: 0, step: 0.5, defaultValue: 6 },
        ],
        // Fix: Update condition signature to match call in handleEvent, which passes 3 arguments.
        condition: (context, config, sim) => context.isCrit && !context.isDot,
        // Fix: Add optional context parameter to match call signature in handleEvent.
        onTrigger: (sim, config, context) => {
            const duration = Math.max(0, Number(config.duration) || 0);
            const haste = (Number(config.hastePercent) || 0) / 100;
            if (duration <= 0 || haste <= 0) {
                return { log: 'Flurry Strike triggered but has no effect.' };
            }
            sim.applyBuff({
                id: 'proc_flurryStrike',
                name: 'Flurry Strike',
                icon: '💨',
                duration,
                type: 'buff',
                onApply: () => sim.addModifier('autoSpeed', 'proc_flurryStrike', haste),
                onExpire: () => sim.removeModifier('autoSpeed', 'proc_flurryStrike'),
            });
            return {
                log: `Flurry Strike increases attack speed by ${config.hastePercent}% for ${duration.toFixed(1)}s.`,
                floatingText: 'Flurry Strike!',
            };
        },
    },
    {
        id: 'overpoweringStrikes',
        name: 'Overpowering Strikes',
        icon: '🗡️',
        description: 'Abilities have a chance to increase all damage done.',
        events: ['damage'],
        defaultConfig: { enabled: true, chance: 25, damagePercent: 15, duration: 8 },
        fields: [
            { key: 'chance', label: 'Proc Chance (%)', min: 0, max: 100, defaultValue: 25 },
            { key: 'damagePercent', label: 'Damage Bonus (%)', min: 0, defaultValue: 15 },
            { key: 'duration', label: 'Duration (s)', min: 0, step: 0.5, defaultValue: 8 },
        ],
        // Fix: Update condition signature to match call in handleEvent, which passes 3 arguments.
        condition: (context, config, sim) => !context.isAuto && !context.isDot,
        // Fix: Add optional context parameter to match call signature in handleEvent.
        onTrigger: (sim, config, context) => {
            const duration = Math.max(0, Number(config.duration) || 0);
            const bonus = (Number(config.damagePercent) || 0) / 100;
            if (duration <= 0 || bonus <= 0) {
                return { log: 'Overpowering Strikes triggered but has no effect.' };
            }
            sim.applyBuff({
                id: 'proc_overpoweringStrikes',
                name: 'Overpowering Strikes',
                icon: '🗡️',
                duration,
                type: 'buff',
                onApply: () => sim.addModifier('damage', 'proc_overpoweringStrikes', bonus),
                onExpire: () => sim.removeModifier('damage', 'proc_overpoweringStrikes'),
            });
            return {
                log: `Overpowering Strikes grants +${config.damagePercent}% damage for ${duration.toFixed(1)}s.`,
                floatingText: 'Overpowering!',
            };
        },
    },
    {
        id: 'criticalInsight',
        name: 'Critical Insight',
        icon: '🎯',
        description: 'Landing a blow can increase your critical strike chance.',
        events: ['damage'],
        defaultConfig: { enabled: true, chance: 20, critPercent: 10, duration: 10 },
        fields: [
            { key: 'chance', label: 'Proc Chance (%)', min: 0, max: 100, defaultValue: 20 },
            { key: 'critPercent', label: 'Crit Chance Bonus (%)', min: 0, defaultValue: 10 },
            { key: 'duration', label: 'Duration (s)', min: 0, step: 0.5, defaultValue: 10 },
        ],
        // Fix: Update condition signature to match call in handleEvent, which passes 3 arguments.
        condition: (context, config, sim) => !context.isDot,
        // Fix: Add optional context parameter to match call signature in handleEvent.
        onTrigger: (sim, config, context) => {
            const duration = Math.max(0, Number(config.duration) || 0);
            const crit = Number(config.critPercent) || 0;
            if (duration <= 0 || crit <= 0) {
                return { log: 'Critical Insight triggered but has no effect.' };
            }
            sim.applyBuff({
                id: 'proc_criticalInsight',
                name: 'Critical Insight',
                icon: '🎯',
                duration,
                type: 'buff',
                onApply: () => sim.addModifier('critChance', 'proc_criticalInsight', crit),
                onExpire: () => sim.removeModifier('critChance', 'proc_criticalInsight'),
            });
            return {
                log: `Critical Insight grants +${crit}% crit chance for ${duration.toFixed(1)}s.`,
                floatingText: 'Critical Insight!',
            };
        },
    },
    {
        id: 'shadowRecovery',
        name: 'Shadow Recovery',
        icon: '🌑',
        description: 'Recover energy and hasten cooldowns after successful abilities.',
        events: ['damage'],
        defaultConfig: { enabled: true, chance: 15, energyGain: 15, cooldownRatePercent: 30, duration: 6 },
        fields: [
            { key: 'chance', label: 'Proc Chance (%)', min: 0, max: 100, defaultValue: 15 },
            { key: 'energyGain', label: 'Energy Gain', min: 0, defaultValue: 15 },
            { key: 'cooldownRatePercent', label: 'CD Recovery (%)', min: 0, defaultValue: 30 },
            { key: 'duration', label: 'Duration (s)', min: 0, step: 0.5, defaultValue: 6 },
        ],
        // Fix: Update condition signature to match call in handleEvent, which passes 3 arguments.
        condition: (context, config, sim) => !context.isAuto && !context.isDot,
        // Fix: Add optional context parameter to match call signature in handleEvent.
        onTrigger: (sim, config, context) => {
            const energy = Math.max(0, Number(config.energyGain) || 0);
            if (energy > 0) {
                sim.refillEnergy(energy);
            }
            const duration = Math.max(0, Number(config.duration) || 0);
            const rate = (Number(config.cooldownRatePercent) || 0) / 100;
            let log = `Shadow Recovery restores ${energy} energy.`;
            if (duration > 0 && rate > 0) {
                sim.applyBuff({
                    id: 'proc_shadowRecovery',
                    name: 'Shadow Recovery',
                    icon: '🌑',
                    duration,
                    type: 'buff',
                    onApply: () => sim.addModifier('cooldownRate', 'proc_shadowRecovery', rate),
                    onExpire: () => sim.removeModifier('cooldownRate', 'proc_shadowRecovery'),
                });
                log += ` Cooldowns recover ${config.cooldownRatePercent}% faster for ${duration.toFixed(1)}s.`;
            }
            if (duration <= 0 || rate <= 0) {
                log += ' Cooldown acceleration unavailable with current settings.';
            }
            return {
                log,
                floatingText: 'Shadow Recovery!',
                floatingTextType: 'energy',
            };
        },
    },
];
class ProcSystem {
    constructor(simulator) {
        this.simulator = simulator;
        this.definitions = PROC_DEFINITIONS;
        this.config = this.getDefaultConfig();
    }
    getDefaultConfig() {
        const config = {};
        this.definitions.forEach(def => {
            config[def.id] = { ...def.defaultConfig };
        });
        return config;
    }
    getConfig() {
        return this.config;
    }
    updateConfig(newConfig = {}) {
        const merged = {};
        this.definitions.forEach(def => {
            const config = { ...def.defaultConfig, ...(newConfig?.[def.id] || {}) };
            config.enabled = Boolean(config.enabled);
            def.fields.forEach(field => {
                const value = config[field.key];
                if (typeof value === 'number') {
                    if (typeof field.min === 'number') {
                        config[field.key] = Math.max(field.min, config[field.key]);
                    }
                    if (typeof field.max === 'number') {
                        config[field.key] = Math.min(field.max, config[field.key]);
                    }
                }
            });
            merged[def.id] = config;
        });
        this.config = merged;
        return this.config;
    }
    handleEvent(event, context) {
        this.definitions.forEach(def => {
            const config = this.config[def.id];
            if (!config?.enabled)
                return;
            if (!def.events.includes(event))
                return;
            if (def.condition && !def.condition(context, config, this.simulator))
                return;
            const chance = Number(config.chance ?? def.defaultConfig?.chance ?? 0);
            if (chance <= 0)
                return;
            if (Math.random() * 100 > chance)
                return;
            // Fix: Explicitly type `result` to handle optional properties from onTrigger and avoid type errors.
            const result = def.onTrigger(this.simulator, config, context) || {};
            const logMessage = result.log ?? `${def.name} triggered!`;
            const floatingText = result.floatingText ?? `${def.icon} ${def.name}!`;
            const floatingType = result.floatingTextType ?? 'proc';
            if (logMessage) {
                this.simulator.ui.addLogEntry(logMessage, 'system');
            }
            if (floatingText) {
                this.simulator.ui.showFloatingText(floatingText, floatingType);
            }
        });
    }
}
class UIController {
    constructor(options = {}) {
        this.idPrefix = options.idPrefix ?? '';
        const resolveId = (id) => (this.idPrefix ? `${this.idPrefix}-${id}` : id);
        const requireElement = (id) => {
            const element = document.getElementById(resolveId(id));
            if (!element) {
                throw new Error(`Missing UI element: ${resolveId(id)}`);
            }
            return element;
        };
        this.elements = {
            dummyHealthBar: requireElement('dummyHealthBar'),
            dummyHealthText: requireElement('dummyHealthText'),
            dummyModel: requireElement('dummyModel'),
            energyBar: requireElement('energyBar'),
            energyText: requireElement('energyText'),
            comboPoints: Array.from(requireElement('comboPoints').querySelectorAll('.combo-point')),
            buffTimers: requireElement('buffTimers'),
            buffList: requireElement('buffList'),
            debuffList: requireElement('debuffList'),
            combatLog: requireElement('combatLog'),
            actionBar: requireElement('actionBar'),
            floatingTextContainer: requireElement('floatingTextContainer'),
            currentDPS: requireElement('currentDPS'),
            totalDamage: requireElement('totalDamage'),
            averageDPS: requireElement('averageDPS'),
            hitCount: requireElement('hitCount'),
            critCount: requireElement('critCount'),
            abilityBreakdownList: requireElement('abilityBreakdownList'),
            forecast1: requireElement('forecast1'),
            forecast3: requireElement('forecast3'),
            forecast5: requireElement('forecast5'),
            combatTimer: requireElement('combatTimer'),
            previousDps: requireElement('previousDps'),
            currentDpsCompare: requireElement('currentDpsCompare'),
            dpsDelta: requireElement('dpsDelta'),
            dpsGraph: requireElement('dpsGraph'),
        };
        this.tooltip = requireElement('tooltip');
        this.forms = {
            attackPower: requireElement('attackPower'),
            weaponMin: requireElement('weaponMin'),
            weaponMax: requireElement('weaponMax'),
            critChance: requireElement('critChance'),
            hitChance: requireElement('hitChance'),
            maxEnergy: requireElement('maxEnergy'),
            tickInterval: requireElement('tickInterval'),
            energyPerTick: requireElement('energyPerTick'),
            talentBonus: requireElement('talentBonus'),
            talentPrecision: requireElement('talentPrecision'),
            talentRelentless: requireElement('talentRelentless'),
            talentShadowTechniques: requireElement('talentShadowTechniques'),
        };
        this.buttons = {
            startCombat: requireElement('startCombat'),
            stopCombat: requireElement('stopCombat'),
            resetCombat: requireElement('resetCombat'),
        };
        this.simulator = null;
        this.soundPlayer = new SoundPlayer();
        this.procInputs = new Map();
        this.procConfigContainer = requireElement('procConfig');
        this.abilityInterceptor = null;
    }
    bindSimulator(simulator) {
        // Fix: Simplify formInputs creation, as this.forms only contains input elements.
        const formInputs = Object.values(this.forms);
        const procInputs = this.getProcInputElements();
        [...formInputs, ...procInputs].forEach(input => {
            const handler = () => {
                simulator.updateConfig(this.getConfigFromInputs());
            };
            input.addEventListener('change', handler);
            // Fix: Add 'input' listener for text and number fields to provide immediate feedback,
            // and handle textareas as well.
            if ((input instanceof HTMLInputElement && (input.type === 'text' || input.type === 'number')) || input instanceof HTMLTextAreaElement) {
                input.addEventListener('input', handler);
            }
        });
        this.buttons.startCombat.addEventListener('click', () => this.simulator?.startCombat());
        this.buttons.stopCombat.addEventListener('click', () => this.simulator?.stopCombat());
        this.buttons.resetCombat.addEventListener('click', () => this.simulator?.reset());
    }
    getConfigFromInputs() {
        const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
        const procConfig = {};
        this.procInputs.forEach((inputs, id) => {
            const values = {};
            inputs.fields.forEach((field, key) => {
                values[key] = Number(field.value) || 0;
            });
            procConfig[id] = {
                enabled: inputs.enabled.checked,
                ...values,
            };
        });
        const rawTickInterval = Number(this.forms.tickInterval.value);
        const tickIntervalMs = Number.isFinite(rawTickInterval) && rawTickInterval > 0
            ? rawTickInterval
            : 2000;
        const clampedTickIntervalMs = Math.max(100, tickIntervalMs);
        return {
            stats: {
                attackPower: Math.max(0, Number(this.forms.attackPower.value) || 0),
                weaponMin: Math.max(0, Number(this.forms.weaponMin.value) || 0),
                weaponMax: Math.max(0, Number(this.forms.weaponMax.value) || 0),
                critChance: clamp(Number(this.forms.critChance.value) || 0, 0, 100),
                hitChance: clamp(Number(this.forms.hitChance.value) || 0, 0, 100),
            },
            regen: {
                tickInterval: clampedTickIntervalMs / 1000,
                energyPerTick: Math.max(0, Number(this.forms.energyPerTick.value) || 0),
                talentBonus: Math.max(0, Number(this.forms.talentBonus.value) || 0) / 100,
                maxEnergy: clamp(Number(this.forms.maxEnergy.value) || 100, 100, 250),
            },
            general: {
                globalCooldown: 1.0,
            },
            talents: {
                precisionStrikes: Boolean(this.forms.talentPrecision?.checked),
                relentlessStrikes: Boolean(this.forms.talentRelentless?.checked),
                shadowTechniques: Boolean(this.forms.talentShadowTechniques?.checked),
            },
            procs: procConfig,
        };
    }
    setConfigInputs(config) {
        const { stats, regen, procs, talents } = config;
        this.forms.attackPower.value = String(stats.attackPower);
        this.forms.weaponMin.value = String(stats.weaponMin);
        this.forms.weaponMax.value = String(stats.weaponMax);
        this.forms.critChance.value = String(stats.critChance);
        this.forms.hitChance.value = String(stats.hitChance);
        this.forms.maxEnergy.value = String(regen.maxEnergy);
        this.forms.tickInterval.value = String(Math.round(regen.tickInterval * 1000));
        this.forms.energyPerTick.value = String(regen.energyPerTick);
        this.forms.talentBonus.value = String(Math.round(regen.talentBonus * 100));
        if (this.forms.talentPrecision) {
            this.forms.talentPrecision.checked = Boolean(talents?.precisionStrikes);
        }
        if (this.forms.talentRelentless) {
            this.forms.talentRelentless.checked = Boolean(talents?.relentlessStrikes);
        }
        if (this.forms.talentShadowTechniques) {
            this.forms.talentShadowTechniques.checked = Boolean(talents?.shadowTechniques);
        }
        if (procs) {
            Object.entries(procs).forEach(([id, values]) => {
                const inputs = this.procInputs.get(id);
                if (!inputs)
                    return;
                inputs.enabled.checked = Boolean(values.enabled);
                inputs.fields.forEach((input, key) => {
                    if (key in values) {
                        input.value = String(values[key]);
                    }
                });
                inputs.updateDisabled?.();
            });
        }
    }
    renderAbilities(abilities) {
        this.elements.actionBar.innerHTML = '';
        abilities.forEach(ability => {
            const button = document.createElement('button');
            button.className = 'ability-button';
            button.dataset.ability = ability.id;
            button.innerHTML = `
                <span>${ability.icon}</span>
                <span class="ability-hotkey">${ability.hotkey}</span>
            `;
            button.addEventListener('click', () => this.useAbility(ability.id));
            button.addEventListener('mouseenter', (event) => this.showTooltip(event, ability));
            button.addEventListener('mouseleave', () => this.hideTooltip());
            this.elements.actionBar.appendChild(button);
        });
    }
    setAbilityInterceptor(handler) {
        this.abilityInterceptor = handler;
    }
    useAbility(abilityId) {
        if (this.abilityInterceptor) {
            const result = this.abilityInterceptor(abilityId);
            if (result === false) {
                return;
            }
        }
        this.simulator?.castAbility(abilityId);
    }
    showTooltip(event, ability) {
        const { currentTarget } = event;
        if (!(currentTarget instanceof HTMLElement))
            return;
        this.tooltip.querySelector('h3').textContent = ability.name;
        this.tooltip.querySelector('p').textContent = ability.description;
        this.tooltip.querySelector('.tooltip-hotkey').textContent = `Hotkey: ${ability.hotkey}`;
        this.tooltip.hidden = false;
        const rect = currentTarget.getBoundingClientRect();
        const top = rect.top - this.tooltip.offsetHeight - 8;
        const left = rect.left + rect.width / 2 - this.tooltip.offsetWidth / 2;
        this.tooltip.style.top = `${Math.max(top, 12)}px`;
        this.tooltip.style.left = `${Math.max(left, 12)}px`;
    }
    hideTooltip() {
        this.tooltip.hidden = true;
    }
    renderProcControls(definitions, config) {
        if (!this.procConfigContainer)
            return;
        this.procConfigContainer.innerHTML = '';
        this.procInputs.clear();
        definitions.forEach(def => {
            const procConfig = config?.[def.id] ?? def.defaultConfig;
            const card = document.createElement('div');
            card.className = 'proc-card';
            const header = document.createElement('div');
            header.className = 'proc-header';
            const title = document.createElement('h3');
            title.textContent = `${def.icon} ${def.name}`;
            header.appendChild(title);
            const toggleLabel = document.createElement('label');
            toggleLabel.innerHTML = '<span>Enabled</span>';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = Boolean(procConfig?.enabled);
            toggleLabel.prepend(checkbox);
            header.appendChild(toggleLabel);
            card.appendChild(header);
            if (def.description) {
                const desc = document.createElement('p');
                desc.textContent = def.description;
                desc.className = 'proc-description';
                card.appendChild(desc);
            }
            const fieldsContainer = document.createElement('div');
            fieldsContainer.className = 'proc-fields';
            const fieldMap = new Map();
            def.fields.forEach(field => {
                const label = document.createElement('label');
                label.innerHTML = `<span>${field.label}</span>`;
                const input = document.createElement('input');
                input.type = 'number';
                if (typeof field.min === 'number')
                    input.min = String(field.min);
                if (typeof field.max === 'number')
                    input.max = String(field.max);
                // Fix: Use a type assertion to access the optional 'step' property, as TypeScript cannot infer it across the complex PROC_DEFINITIONS union type.
                if (typeof field.step === 'number')
                    input.step = String(field.step);
                input.value = String(procConfig?.[field.key] ?? field.defaultValue ?? 0);
                label.appendChild(input);
                fieldsContainer.appendChild(label);
                fieldMap.set(field.key, input);
            });
            card.appendChild(fieldsContainer);
            this.procConfigContainer.appendChild(card);
            const updateDisabled = () => {
                const disabled = !checkbox.checked;
                fieldMap.forEach(input => {
                    input.disabled = disabled;
                });
            };
            checkbox.addEventListener('change', updateDisabled);
            const record = { enabled: checkbox, fields: fieldMap, updateDisabled };
            this.procInputs.set(def.id, record);
            updateDisabled();
        });
    }
    getProcInputElements() {
        const elements = [];
        this.procInputs.forEach(inputs => {
            elements.push(inputs.enabled);
            inputs.fields.forEach(field => elements.push(field));
        });
        return elements;
    }
    showDamageNumber(damage, { isCrit = false, isAuto = false }) {
        const container = this.elements.floatingTextContainer;
        if (!container)
            return;
        const node = document.createElement('div');
        node.className = 'damage-number';
        if (isCrit)
            node.classList.add('crit');
        if (isAuto) {
            node.classList.add('auto');
        }
        node.textContent = String(Math.floor(damage));
        // Random horizontal and vertical offset to prevent stacking
        const horizontalOffset = (Math.random() * 80) - 40; // -40px to +40px
        const verticalOffset = (Math.random() * 30) - 15; // -15px to +15px
        node.style.setProperty('--horizontal-offset', `${horizontalOffset}px`);
        node.style.setProperty('--vertical-offset', `${verticalOffset}px`);
        // Scale font size based on damage, especially for crits
        let baseSize = 1.6; // rem
        if (isCrit) {
            baseSize = 2.5;
        }
        // A gentle scaling for very large numbers.
        const scalingFactor = Math.log10(Math.max(10, damage)) / 4; // e.g. 100 -> 0.5, 1000 -> 0.75, 10000 -> 1
        const finalSize = baseSize + scalingFactor;
        // Clamp max font size to avoid excessively large numbers
        node.style.fontSize = `${Math.min(finalSize, 6)}rem`;
        container.appendChild(node);
        setTimeout(() => node.remove(), 1500);
    }
    showFloatingText(message, type = 'proc') {
        const container = this.elements.floatingTextContainer;
        if (!container)
            return;
        const node = document.createElement('div');
        node.className = `floating-text ${type}`;
        node.textContent = message;
        const offset = (Math.random() * 20) - 10;
        node.style.top = `${50 + offset}%`;
        container.appendChild(node);
        setTimeout(() => node.remove(), 1200);
    }
    updateResources(state) {
        const energyPercent = (state.energy / state.maxEnergy) * 100;
        this.elements.energyBar.style.width = `${energyPercent}%`;
        this.elements.energyText.textContent = `${Math.floor(state.energy)} / ${state.maxEnergy}`;
        this.elements.comboPoints.forEach((cp, idx) => {
            cp.classList.toggle('active', idx < state.comboPoints);
        });
    }
    updateDummy(state) {
        const healthPercent = Math.max(0, (state.dummyHealth / state.dummyMaxHealth) * 100);
        this.elements.dummyHealthBar.style.width = `${healthPercent}%`;
        this.elements.dummyHealthText.textContent = `${healthPercent.toFixed(1)}%`;
    }
    flashDummy() {
        this.elements.dummyModel.classList.add('hit');
        setTimeout(() => this.elements.dummyModel.classList.remove('hit'), 160);
        this.soundPlayer.playHit();
    }
    updateBuffTimers(buffValues, debuffValues) {
        this.elements.buffTimers.innerHTML = '';
        [...buffValues, ...debuffValues].forEach(effect => {
            const pill = document.createElement('div');
            pill.className = `buff-pill ${effect.type === 'debuff' ? 'debuff' : ''}`;
            const icon = effect.icon ? `${effect.icon} ` : '';
            pill.textContent = `${icon}${effect.name} - ${effect.remaining.toFixed(1)}s`;
            this.elements.buffTimers.appendChild(pill);
        });
    }
    updateBuffLists(buffValues, debuffValues) {
        this.elements.buffList.innerHTML = '';
        buffValues.forEach(effect => {
            const row = document.createElement('div');
            row.className = 'buff-row';
            row.innerHTML = `
                <span class="buff-name">
                    ${effect.icon ? `<span class="buff-icon">${effect.icon}</span>` : ''}
                    <span>${effect.name}</span>
                </span>
                <span>${effect.remaining.toFixed(1)}s</span>
            `;
            this.elements.buffList.appendChild(row);
        });
        this.elements.debuffList.innerHTML = '';
        debuffValues.forEach(effect => {
            const row = document.createElement('div');
            row.className = 'buff-row debuff';
            row.innerHTML = `
                <span class="buff-name">
                    ${effect.icon ? `<span class="buff-icon">${effect.icon}</span>` : ''}
                    <span>${effect.name}</span>
                </span>
                <span>${effect.remaining.toFixed(1)}s</span>
            `;
            this.elements.debuffList.appendChild(row);
        });
    }
    addLogEntry(message, type = 'ability') {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = message;
        this.elements.combatLog.prepend(entry);
        if (this.elements.combatLog.childElementCount > 120) {
            this.elements.combatLog.lastElementChild?.remove();
        }
    }
    updateStats(stats, currentDps) {
        this.elements.totalDamage.textContent = stats.totalDamage.toLocaleString();
        this.elements.averageDPS.textContent = `${Math.floor(stats.totalDamage / Math.max(stats.combatTime, 1))}`;
        this.elements.hitCount.textContent = String(stats.hitCount);
        this.elements.critCount.textContent = String(stats.critCount);
        this.elements.currentDPS.textContent = String(Math.floor(currentDps));
    }
    updateAbilityBreakdown(usageMap, totalDamage) {
        const container = this.elements.abilityBreakdownList;
        if (!container)
            return;
        container.innerHTML = '';
        const entries = Array.from(usageMap.entries()).map(([name, data]) => ({
            name,
            count: data.count,
            damage: data.damage,
            percent: totalDamage > 0 ? (data.damage / totalDamage) * 100 : 0,
        })).sort((a, b) => b.damage - a.damage);
        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'breakdown-empty';
            empty.textContent = 'Use abilities to see their contribution breakdown here.';
            container.appendChild(empty);
            return;
        }
        entries.forEach((entry, index) => {
            const row = document.createElement('div');
            row.className = 'breakdown-row';
            if (index === 0) {
                row.classList.add('top');
            }
            const rank = document.createElement('span');
            rank.className = 'breakdown-name';
            rank.innerHTML = `<strong>${index + 1}.</strong> ${entry.name}`;
            const uses = document.createElement('span');
            uses.className = 'breakdown-count';
            const label = entry.count === 1 ? 'use' : 'uses';
            uses.textContent = `${entry.count} ${label}`;
            const damage = document.createElement('span');
            damage.className = 'breakdown-damage';
            damage.textContent = `${Math.round(entry.damage).toLocaleString()} dmg`;
            const percent = document.createElement('span');
            percent.className = 'breakdown-percent';
            percent.textContent = `${entry.percent.toFixed(1)}%`;
            row.append(rank, uses, damage, percent);
            container.appendChild(row);
        });
    }
    updateForecast(values) {
        this.elements.forecast1.textContent = `${values.in1s}`;
        this.elements.forecast3.textContent = `${values.in3s}`;
        this.elements.forecast5.textContent = `${values.in5s}`;
    }
    updateCombatTimer(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
        this.elements.combatTimer.textContent = `${mins}:${secs}`;
    }
    updateSessionComparison(previous, current) {
        if (previous) {
            this.elements.previousDps.textContent = `${previous.dps.toFixed(1)} (${previous.duration.toFixed(1)}s)`;
        }
        else {
            this.elements.previousDps.textContent = '-';
        }
        if (current) {
            this.elements.currentDpsCompare.textContent = `${current.dps.toFixed(1)} (${current.duration.toFixed(1)}s)`;
        }
        else {
            this.elements.currentDpsCompare.textContent = '-';
        }
        if (previous && current) {
            const delta = current.dps - previous.dps;
            const sign = delta > 0 ? '+' : '';
            this.elements.dpsDelta.textContent = `${sign}${delta.toFixed(1)}`;
            this.elements.dpsDelta.style.color = delta >= 0 ? '#6bff98' : '#ff8686';
        }
        else {
            this.elements.dpsDelta.textContent = '-';
            this.elements.dpsDelta.style.color = '#f4f6fb';
        }
    }
    updateAbilityCooldowns(cooldowns) {
        // Fix: Cast querySelectorAll result to HTMLElement array.
        const buttons = Array.from(this.elements.actionBar.querySelectorAll('.ability-button'));
        buttons.forEach(btn => {
            const abilityId = btn.dataset.ability;
            const remaining = cooldowns.get(abilityId);
            if (remaining && remaining > 0.1) {
                btn.classList.add('on-cooldown');
                btn.dataset.cooldown = remaining.toFixed(1);
            }
            else {
                btn.classList.remove('on-cooldown');
                delete btn.dataset.cooldown;
            }
        });
    }
    updateDpsGraph(history) {
        const ctx = this.elements.dpsGraph.getContext('2d');
        const canvas = this.elements.dpsGraph;
        if (!ctx)
            return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (history.length < 2)
            return;
        const maxDps = Math.max(...history.map(point => point.dps), 10);
        const minTime = history[0].time;
        const maxTime = history[history.length - 1].time;
        const timeRange = Math.max(maxTime - minTime, 1);
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        history.forEach((point, index) => {
            const x = ((point.time - minTime) / timeRange) * canvas.width;
            const y = canvas.height - (point.dps / maxDps) * canvas.height;
            if (index === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        });
        ctx.stroke();
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, 'rgba(255, 215, 0, 0.35)');
        gradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.lineTo(canvas.width, canvas.height);
        ctx.lineTo(0, canvas.height);
        ctx.closePath();
        ctx.fill();
    }
    setHotkeyMap(map) {
        this.hotkeyMap = map;
    }
    attachHotkeyListeners() {
        if (this.keyHandler)
            return;
        this.keyHandler = (event) => {
            if (event.repeat)
                return;
            const target = event.target;
            // Fix: Check if target is an HTMLElement to access properties like isContentEditable.
            if (target instanceof HTMLElement) {
                if (target instanceof HTMLInputElement ||
                    target instanceof HTMLTextAreaElement ||
                    target instanceof HTMLSelectElement ||
                    target.isContentEditable) {
                    return;
                }
                const editableAncestor = target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
                if (editableAncestor) {
                    return;
                }
            }
            const abilityId = this.hotkeyMap?.get(event.key.toLowerCase());
            if (abilityId) {
                event.preventDefault();
                this.useAbility(abilityId);
            }
        };
        document.addEventListener('keydown', this.keyHandler);
    }
    detachHotkeyListeners() {
        if (!this.keyHandler)
            return;
        document.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = undefined;
    }
}
class ActionRpgUIController extends UIController {
    constructor() {
        super({ idPrefix: 'arpg' });
        this.game = null;
        this.minimapCanvas = document.getElementById('arpg-minimap');
        this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
        this.targetName = document.getElementById('arpg-targetName');
        this.targetFrame = document.getElementById('arpg-targetFrame');
        this.rangeWarning = document.getElementById('arpg-rangeWarning');
        this.playerBuffContainer = document.getElementById('arpg-playerBuffs');
        this.dpsMeterValue = document.getElementById('arpg-currentDPS');
        this.worldProjector = null;
        this.combatLogWindow = document.getElementById('arpg-combatLogWindow');
        this.combatLogHandle = document.getElementById('arpg-combatLogHandle');
        this.dragState = { active: false, offsetX: 0, offsetY: 0 };
        this.enableDrag();
    }
    setGame(game) {
        this.game = game;
    }
    setWorldProjector(projector) {
        this.worldProjector = projector;
    }
    getMinimapContext() {
        return this.minimapCtx;
    }
    updateActionBarPosition(x, y) {
        const bar = this.elements.actionBar;
        bar.style.left = `${x}px`;
        bar.style.top = `${y}px`;
    }
    updateTargetFrame(info) {
        if (!info) {
            this.targetFrame.classList.add('hidden');
            this.targetName.textContent = 'No Target';
            return;
        }
        this.targetFrame.classList.remove('hidden');
        this.targetName.textContent = info.name;
    }
    showRangeWarning(message) {
        if (!message) {
            this.rangeWarning.classList.remove('visible');
            this.rangeWarning.textContent = '';
        }
        else {
            this.rangeWarning.classList.add('visible');
            this.rangeWarning.textContent = message;
        }
    }
    updateDpsMeter(value) {
        this.dpsMeterValue.textContent = value.toFixed(1);
    }
    updateBuffTimers(buffValues, debuffValues) {
        super.updateBuffTimers(buffValues, debuffValues);
        const container = this.playerBuffContainer;
        container.innerHTML = '';
        [...buffValues, ...debuffValues].forEach(effect => {
            const node = document.createElement('div');
            node.className = `player-buff ${effect.type === 'debuff' ? 'debuff' : ''}`;
            node.textContent = `${effect.icon ?? ''}`;
            node.title = `${effect.name} (${effect.remaining.toFixed(1)}s)`;
            container.appendChild(node);
        });
    }
    flashDummy() {
        this.soundPlayer.playHit();
        this.game?.flashTarget();
    }
    showDamageNumber(damage, { isCrit = false, isAuto = false }) {
        const container = this.elements.floatingTextContainer;
        if (!container)
            return;
        const node = document.createElement('div');
        node.className = 'damage-number anchored';
        if (isCrit)
            node.classList.add('crit');
        if (isAuto)
            node.classList.add('auto');
        node.textContent = String(Math.floor(damage));
        const anchor = this.worldProjector?.('target');
        if (anchor) {
            node.style.left = `${anchor.x}px`;
            node.style.top = `${anchor.y}px`;
        }
        container.appendChild(node);
        setTimeout(() => node.remove(), 1600);
    }
    showFloatingText(message, type = 'proc') {
        const container = this.elements.floatingTextContainer;
        if (!container)
            return;
        const node = document.createElement('div');
        node.className = `floating-text anchored ${type}`;
        node.textContent = message;
        const anchor = this.worldProjector?.('player');
        if (anchor) {
            node.style.left = `${anchor.x}px`;
            node.style.top = `${anchor.y}px`;
        }
        container.appendChild(node);
        setTimeout(() => node.remove(), 1200);
    }
    updateResources(state) {
        super.updateResources(state);
        this.updateDpsMeter(this.game ? this.game.getCurrentDps() : 0);
    }
    enableDrag() {
        if (!this.combatLogWindow || !this.combatLogHandle)
            return;
        const windowEl = this.combatLogWindow;
        const handle = this.combatLogHandle;
        const onMouseMove = (event) => {
            if (!this.dragState.active)
                return;
            windowEl.style.left = `${event.clientX - this.dragState.offsetX}px`;
            windowEl.style.top = `${event.clientY - this.dragState.offsetY}px`;
        };
        const onMouseUp = () => {
            this.dragState.active = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        handle.addEventListener('mousedown', (event) => {
            this.dragState.active = true;
            const rect = windowEl.getBoundingClientRect();
            this.dragState.offsetX = event.clientX - rect.left;
            this.dragState.offsetY = event.clientY - rect.top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
}
class EntityCollection {
    constructor(initial) {
        this.items = new Map();
        initial?.forEach(entity => this.add(entity));
    }
    add(entity) {
        this.items.set(entity.id, entity);
    }
    remove(id) {
        this.items.delete(id);
    }
    getById(id) {
        return this.items.get(id) ?? null;
    }
    first(predicate) {
        if (!predicate) {
            for (const entity of this.items.values()) {
                return entity;
            }
            return null;
        }
        for (const entity of this.items.values()) {
            if (predicate(entity)) {
                return entity;
            }
        }
        return null;
    }
    forEach(callback) {
        this.items.forEach(entity => callback(entity));
    }
    map(callback) {
        return Array.from(this.items.values(), callback);
    }
    filter(predicate) {
        const results = [];
        this.items.forEach(entity => {
            if (predicate(entity)) {
                results.push(entity);
            }
        });
        return results;
    }
    find(predicate) {
        for (const entity of this.items.values()) {
            if (predicate(entity)) {
                return entity;
            }
        }
        return null;
    }
    toArray() {
        return Array.from(this.items.values());
    }
    get size() {
        return this.items.size;
    }
    [Symbol.iterator]() {
        return this.items.values();
    }
}
class ActionRpgGame {
    constructor(canvas, ui, simulator) {
        this.tick = (timestamp) => {
            if (!this.running)
                return;
            const delta = (timestamp - this.lastTimestamp) / 1000;
            this.lastTimestamp = timestamp;
            this.update(delta);
            this.render();
            this.loopHandle = requestAnimationFrame(this.tick);
        };
        this.onKeyDown = (event) => {
            if (event.repeat)
                return;
            if (event.code === 'Tab') {
                event.preventDefault();
                this.cycleTarget();
                return;
            }
            if (event.code === 'KeyX') {
                this.toggleStealth();
                return;
            }
            this.keys.add(event.code);
        };
        this.onKeyUp = (event) => {
            this.keys.delete(event.code);
        };
        this.onClick = (event) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const world = this.screenToWorld(x, y);
            const clicked = this.dummies.find(dummy => Math.hypot(dummy.x - world.x, dummy.y - world.y) <= dummy.radius + 6);
            if (clicked) {
                this.selectTarget(clicked);
            }
            else {
                this.selectTarget(null);
            }
        };
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D context unavailable for ARPG mode');
        }
        this.canvas = canvas;
        this.ctx = ctx;
        this.ui = ui;
        this.simulator = simulator;
        this.tileSize = 64;
        this.map = this.createMap();
        this.keys = new Set();
        this.player = {
            x: this.tileSize * 3,
            y: this.tileSize * 3,
            width: 42,
            height: 56,
            baseSpeed: 160,
            sprintSpeed: 240,
            animationTimer: 0,
            animationFrame: 0,
            facing: 'right',
            stealth: false,
        };
        this.camera = { x: this.player.x, y: this.player.y };
        this.dummies = new EntityCollection(this.createDummies());
        this.adapters = new Map();
        this.currentTarget = this.dummies.first() ?? null;
        this.meleeRange = 110;
        this.running = false;
        this.loopHandle = null;
        this.lastTimestamp = performance.now();
        this.sprintEnergyCost = 18;
        this.ui.setGame(this);
        this.ui.setWorldProjector((entity) => this.getAnchor(entity));
        this.ui.setAbilityInterceptor((abilityId) => this.handleAbilityIntercept(abilityId));
        this.ui.updateTargetFrame(this.currentTarget ? this.getTargetInfo(this.currentTarget) : null);
        if (this.currentTarget) {
            this.simulator.setExternalTarget(this.getAdapter(this.currentTarget));
        }
    }
    getCurrentDps() {
        return this.simulator.getCurrentDps();
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.bindInput();
        this.lastTimestamp = performance.now();
        this.loopHandle = requestAnimationFrame(this.tick);
    }
    stop() {
        if (!this.running)
            return;
        this.running = false;
        if (this.loopHandle !== null) {
            cancelAnimationFrame(this.loopHandle);
            this.loopHandle = null;
        }
        this.unbindInput();
    }
    destroy() {
        this.stop();
        this.ui.setAbilityInterceptor(null);
        this.ui.setWorldProjector(null);
    }
    update(delta) {
        this.updatePlayer(delta);
        this.updateDummies(delta);
        this.updateCamera();
        this.updateActionBar();
        this.drawMinimap();
    }
    updatePlayer(delta) {
        const speed = this.getMovementSpeed(delta);
        let moveX = 0;
        let moveY = 0;
        if (this.keys.has('KeyW'))
            moveY -= 1;
        if (this.keys.has('KeyS'))
            moveY += 1;
        if (this.keys.has('KeyA')) {
            moveX -= 1;
            this.player.facing = 'left';
        }
        if (this.keys.has('KeyD')) {
            moveX += 1;
            this.player.facing = 'right';
        }
        const magnitude = Math.hypot(moveX, moveY);
        if (magnitude > 0) {
            moveX /= magnitude;
            moveY /= magnitude;
            this.player.animationTimer += delta;
            if (this.player.animationTimer >= 0.15) {
                this.player.animationTimer = 0;
                this.player.animationFrame = (this.player.animationFrame + 1) % 2;
            }
        }
        else {
            this.player.animationFrame = 0;
            this.player.animationTimer = 0;
        }
        this.tryMove(moveX * speed * delta, moveY * speed * delta);
    }
    getMovementSpeed(delta) {
        const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
        if (sprinting && this.simulator.state.energy > 0) {
            const cost = this.sprintEnergyCost * delta;
            this.simulator.spendEnergy(cost);
            return this.player.sprintSpeed;
        }
        return this.player.baseSpeed;
    }
    tryMove(dx, dy) {
        const nextX = this.player.x + dx;
        const nextY = this.player.y + dy;
        if (this.isWalkable(nextX, this.player.y, this.player.width, this.player.height)) {
            this.player.x = nextX;
        }
        if (this.isWalkable(this.player.x, nextY, this.player.width, this.player.height)) {
            this.player.y = nextY;
        }
    }
    isWalkable(x, y, width, height) {
        const halfW = width / 2;
        const halfH = height / 2;
        const bounds = [
            { x: x - halfW, y: y - halfH },
            { x: x + halfW, y: y - halfH },
            { x: x - halfW, y: y + halfH },
            { x: x + halfW, y: y + halfH },
        ];
        return bounds.every(point => this.isTileWalkable(point.x, point.y));
    }
    isTileWalkable(x, y) {
        if (x < 0 || y < 0)
            return false;
        const tileX = Math.floor(x / this.tileSize);
        const tileY = Math.floor(y / this.tileSize);
        if (tileY < 0 || tileY >= this.map.length)
            return false;
        if (tileX < 0 || tileX >= this.map[0].length)
            return false;
        const tile = this.map[tileY][tileX];
        return tile !== 2;
    }
    updateDummies(delta) {
        this.dummies.forEach(dummy => {
            if (dummy.health <= 0) {
                dummy.respawnTimer -= delta;
                if (dummy.respawnTimer <= 0) {
                    dummy.health = dummy.maxHealth;
                    dummy.respawnTimer = 0;
                    if (dummy === this.currentTarget) {
                        this.simulator.setExternalTarget(this.getAdapter(dummy));
                    }
                }
            }
            if (dummy.highlight > 0) {
                dummy.highlight = Math.max(0, dummy.highlight - delta * 3);
            }
        });
    }
    updateCamera() {
        const halfWidth = this.canvas.width / 2;
        const halfHeight = this.canvas.height / 2;
        const mapWidth = this.map[0].length * this.tileSize;
        const mapHeight = this.map.length * this.tileSize;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        this.camera.x = clamp(this.player.x, halfWidth, mapWidth - halfWidth);
        this.camera.y = clamp(this.player.y, halfHeight, mapHeight - halfHeight);
    }
    updateActionBar() {
        const playerScreen = this.worldToScreen(this.player.x, this.player.y);
        this.ui.updateActionBarPosition(playerScreen.x - 160, playerScreen.y + 60);
    }
    drawMinimap() {
        const ctx = this.ui.getMinimapContext();
        const canvas = this.ui.minimapCanvas;
        if (!ctx || !canvas)
            return;
        const scaleX = canvas.width / (this.map[0].length * this.tileSize);
        const scaleY = canvas.height / (this.map.length * this.tileSize);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#1f1f24';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        this.map.forEach((row, y) => {
            row.forEach((tile, x) => {
                if (tile === 2) {
                    ctx.fillStyle = '#2c2f3a';
                }
                else if (tile === 1) {
                    ctx.fillStyle = '#1b412f';
                }
                else {
                    ctx.fillStyle = '#304a73';
                }
                ctx.fillRect(x * this.tileSize * scaleX, y * this.tileSize * scaleY, this.tileSize * scaleX, this.tileSize * scaleY);
            });
        });
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(this.player.x * scaleX, this.player.y * scaleY, 6, 0, Math.PI * 2);
        ctx.fill();
        this.dummies.forEach(dummy => {
            ctx.fillStyle = dummy === this.currentTarget ? '#ef476f' : '#06d6a0';
            ctx.beginPath();
            ctx.arc(dummy.x * scaleX, dummy.y * scaleY, 5, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.drawTiles();
        this.drawDummies();
        this.drawPlayer();
    }
    drawTiles() {
        for (let y = 0; y < this.map.length; y++) {
            for (let x = 0; x < this.map[y].length; x++) {
                const tile = this.map[y][x];
                const screen = this.worldToScreen((x + 0.5) * this.tileSize, (y + 0.5) * this.tileSize);
                const drawX = screen.x - this.tileSize / 2;
                const drawY = screen.y - this.tileSize / 2;
                if (tile === 2) {
                    this.ctx.fillStyle = '#1d1e26';
                }
                else if (tile === 1) {
                    this.ctx.fillStyle = '#283845';
                }
                else {
                    this.ctx.fillStyle = '#1f2933';
                }
                this.ctx.fillRect(drawX, drawY, this.tileSize, this.tileSize);
            }
        }
    }
    drawDummies() {
        this.dummies.forEach(dummy => {
            const screen = this.worldToScreen(dummy.x, dummy.y);
            const radius = dummy.radius;
            if (dummy.health <= 0) {
                this.ctx.globalAlpha = 0.35;
            }
            this.ctx.fillStyle = '#7c4dff';
            this.ctx.beginPath();
            this.ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
            this.ctx.fill();
            if (dummy.highlight > 0) {
                this.ctx.strokeStyle = `rgba(255,255,255,${dummy.highlight})`;
                this.ctx.lineWidth = 4;
                this.ctx.beginPath();
                this.ctx.arc(screen.x, screen.y, radius + 4, 0, Math.PI * 2);
                this.ctx.stroke();
            }
            this.ctx.globalAlpha = 1;
            // HP bar
            const barWidth = radius * 2;
            const barHeight = 6;
            const healthPercent = Math.max(0, dummy.health / dummy.maxHealth);
            this.ctx.fillStyle = '#1f1f1f';
            this.ctx.fillRect(screen.x - radius, screen.y - radius - 16, barWidth, barHeight);
            this.ctx.fillStyle = '#06d6a0';
            this.ctx.fillRect(screen.x - radius, screen.y - radius - 16, barWidth * healthPercent, barHeight);
            if (dummy === this.currentTarget) {
                this.ctx.strokeStyle = '#ffd166';
                this.ctx.lineWidth = 2;
                this.ctx.strokeRect(screen.x - radius - 4, screen.y - radius - 20, barWidth + 8, barHeight + 8);
            }
        });
    }
    drawPlayer() {
        const screen = this.worldToScreen(this.player.x, this.player.y);
        this.ctx.save();
        if (this.player.stealth) {
            this.ctx.globalAlpha = 0.55;
        }
        this.ctx.translate(screen.x, screen.y);
        if (this.player.facing === 'left') {
            this.ctx.scale(-1, 1);
        }
        this.ctx.fillStyle = '#ef476f';
        const frameOffset = this.player.animationFrame === 0 ? 0 : 4;
        this.ctx.fillRect(-this.player.width / 2, -this.player.height / 2 - frameOffset, this.player.width, this.player.height);
        this.ctx.fillStyle = '#ffd166';
        this.ctx.fillRect(-8, -this.player.height / 2 - frameOffset - 6, 16, 16);
        this.ctx.restore();
        this.ctx.globalAlpha = 1;
    }
    flashTarget() {
        if (!this.currentTarget)
            return;
        this.currentTarget.highlight = 1;
    }
    createMap() {
        const rows = 18;
        const cols = 24;
        const layout = [];
        for (let y = 0; y < rows; y++) {
            const row = [];
            for (let x = 0; x < cols; x++) {
                if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) {
                    row.push(2); // wall
                }
                else {
                    row.push(0);
                }
            }
            layout.push(row);
        }
        // Create simple rooms and corridors
        const carveRoom = (startX, startY, w, h) => {
            for (let y = startY; y < startY + h; y++) {
                for (let x = startX; x < startX + w; x++) {
                    if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) {
                        layout[y][x] = 1;
                    }
                }
            }
        };
        carveRoom(2, 2, 7, 6);
        carveRoom(10, 2, 8, 6);
        carveRoom(5, 10, 12, 6);
        // Corridors
        for (let x = 7; x < 17; x++)
            layout[7][x] = 1;
        for (let y = 7; y < 13; y++)
            layout[y][7] = 1;
        return layout;
    }
    createDummies() {
        return [
            { kind: 'dummy', id: 'dummy-1', name: 'Training Dummy Alpha', x: this.tileSize * 4, y: this.tileSize * 4, radius: 24, maxHealth: 15000, health: 15000, respawnTimer: 0, highlight: 0 },
            { kind: 'dummy', id: 'dummy-2', name: 'Training Dummy Beta', x: this.tileSize * 12, y: this.tileSize * 4, radius: 24, maxHealth: 20000, health: 20000, respawnTimer: 0, highlight: 0 },
            { kind: 'dummy', id: 'dummy-3', name: 'Training Dummy Gamma', x: this.tileSize * 9, y: this.tileSize * 12, radius: 24, maxHealth: 25000, health: 25000, respawnTimer: 0, highlight: 0 },
        ];
    }
    bindInput() {
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        this.canvas.addEventListener('click', this.onClick);
    }
    unbindInput() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        this.canvas.removeEventListener('click', this.onClick);
    }
    toggleStealth() {
        this.player.stealth = !this.player.stealth;
        if (this.player.stealth) {
            this.simulator.applyBuff({ id: 'stealth', name: 'Stealth', duration: Infinity, icon: '🕶️', type: 'buff' });
        }
        else {
            this.simulator.removeBuff('stealth');
        }
    }
    cycleTarget() {
        if (this.dummies.size === 0)
            return;
        const alive = this.dummies.filter(dummy => dummy.health > 0);
        if (alive.length === 0)
            return;
        const currentId = this.currentTarget?.id;
        const currentIndex = currentId ? alive.findIndex(dummy => dummy.id === currentId) : 0;
        const next = alive[(currentIndex + 1) % alive.length];
        this.selectTarget(next);
    }
    selectTarget(dummy) {
        this.currentTarget = dummy;
        if (dummy) {
            this.simulator.setExternalTarget(this.getAdapter(dummy));
            this.ui.updateTargetFrame(this.getTargetInfo(dummy));
        }
        else {
            this.simulator.stopCombat();
            this.simulator.setExternalTarget(null);
            this.ui.updateTargetFrame(null);
        }
        this.ui.showRangeWarning('');
    }
    handleAbilityIntercept(_abilityId) {
        if (!this.currentTarget) {
            this.ui.showRangeWarning('Kein Ziel ausgewählt');
            return false;
        }
        if (this.currentTarget.health <= 0) {
            this.ui.showRangeWarning('Ziel ist besiegt');
            return false;
        }
        const distance = Math.hypot(this.player.x - this.currentTarget.x, this.player.y - this.currentTarget.y);
        if (distance > this.meleeRange) {
            this.ui.showRangeWarning('Außer Reichweite');
            return false;
        }
        this.ui.showRangeWarning('');
        return true;
    }
    getAdapter(dummy) {
        let adapter = this.adapters.get(dummy.id);
        if (!adapter) {
            adapter = {
                getCurrentHealth: () => dummy.health,
                getMaxHealth: () => dummy.maxHealth,
                applyDamage: (amount) => {
                    dummy.health = Math.max(0, dummy.health - amount);
                    dummy.highlight = 1;
                    if (dummy.health <= 0) {
                        dummy.respawnTimer = 5;
                    }
                },
                onCombatStart: () => { },
                onCombatEnd: () => { },
                onReset: () => {
                    dummy.health = dummy.maxHealth;
                    dummy.respawnTimer = 0;
                },
                onDefeated: () => { },
            };
            this.adapters.set(dummy.id, adapter);
        }
        return adapter;
    }
    getTargetInfo(dummy) {
        return { id: dummy.id, name: dummy.name, health: dummy.health, maxHealth: dummy.maxHealth };
    }
    getAnchor(entity) {
        if (entity === 'player') {
            const pos = this.worldToScreen(this.player.x, this.player.y - this.player.height / 2);
            return { x: pos.x, y: pos.y - 40 };
        }
        if (entity === 'target' && this.currentTarget) {
            const pos = this.worldToScreen(this.currentTarget.x, this.currentTarget.y - this.currentTarget.radius - 10);
            return { x: pos.x, y: pos.y };
        }
        return null;
    }
    worldToScreen(x, y) {
        return {
            x: Math.round((x - this.camera.x) + this.canvas.width / 2),
            y: Math.round((y - this.camera.y) + this.canvas.height / 2),
        };
    }
    screenToWorld(x, y) {
        return {
            x: this.camera.x - this.canvas.width / 2 + x,
            y: this.camera.y - this.canvas.height / 2 + y,
        };
    }
}
class RogueSimulator {
    constructor(ui) {
        this.ui = ui;
        this.externalTarget = null;
        this.defaultDummyHealth = 1000000;
        this.state = {
            inCombat: false,
            energy: 100,
            maxEnergy: 100,
            comboPoints: 0,
            maxComboPoints: 5,
            globalCooldown: 0,
            dummyMaxHealth: this.defaultDummyHealth,
            dummyHealth: this.defaultDummyHealth,
            autoAttackTimer: 2,
            baseAutoSpeed: 2,
            energyTickProgress: 0,
            modifiers: {
                autoSpeed: new Map(),
                energyRegen: new Map(),
                damage: new Map(),
                critChance: new Map(),
                cooldownRate: new Map(),
            },
            buffs: new Map(),
            debuffs: new Map(),
            cooldowns: new Map(),
            stats: {
                totalDamage: 0,
                hitCount: 0,
                critCount: 0,
                combatTime: 0,
                dpsHistory: [],
                abilityUsage: new Map(),
            },
        };
        this.procSystem = new ProcSystem(this);
        this.ui.renderProcControls(this.procSystem.definitions, this.procSystem.getConfig());
        const initialConfig = this.applyConfigDefaults(this.ui.getConfigFromInputs());
        initialConfig.procs = this.procSystem.updateConfig(initialConfig.procs);
        this.config = initialConfig;
        this.state.maxEnergy = this.config.regen.maxEnergy;
        this.state.energy = this.config.regen.maxEnergy;
        this.ui.setConfigInputs(this.config);
        this.abilities = this.initializeAbilities();
        this.hotkeyMap = new Map();
        this.ui.renderAbilities(this.abilities);
        this.abilities.forEach(ability => this.hotkeyMap.set(ability.hotkey.toLowerCase(), ability.id));
        this.ui.setHotkeyMap(this.hotkeyMap);
        this.ui.attachHotkeyListeners();
        this.loopHandle = null;
        this.lastTimestamp = performance.now();
        this.sessionHistory = [];
        this.currentSession = null;
        this.previousSession = null;
        this.resume();
    }
    setExternalTarget(target) {
        this.externalTarget = target;
        if (target) {
            this.state.dummyMaxHealth = target.getMaxHealth();
            this.state.dummyHealth = target.getCurrentHealth();
        }
        else {
            this.state.dummyMaxHealth = this.defaultDummyHealth;
            this.state.dummyHealth = this.defaultDummyHealth;
        }
    }
    getDefaultConfig() {
        return {
            stats: {
                attackPower: 1200,
                weaponMin: 150,
                weaponMax: 220,
                critChance: 25,
                hitChance: 95,
            },
            regen: {
                tickInterval: 2,
                energyPerTick: 20,
                talentBonus: 0.3,
                maxEnergy: 100,
            },
            general: {
                globalCooldown: 1.0,
            },
            talents: {
                precisionStrikes: false,
                relentlessStrikes: false,
                shadowTechniques: false,
            },
            procs: this.procSystem.getDefaultConfig(),
        };
    }
    applyConfigDefaults(config = {}) {
        const defaults = this.getDefaultConfig();
        return {
            stats: { ...defaults.stats, ...(config.stats || {}) },
            regen: { ...defaults.regen, ...(config.regen || {}) },
            general: { ...defaults.general, ...(config.general || {}) },
            talents: { ...defaults.talents, ...(config.talents || {}) },
            procs: config.procs || defaults.procs,
        };
    }
    initializeAbilities() {
        const abilityList = [];
        abilityList.push(new Ability({
            id: 'sinisterStrike',
            name: 'Sinister Strike',
            icon: '🗡️',
            hotkey: '1',
            energyCost: 40,
            comboPoints: 1,
            cooldown: 0,
            description: 'Deal weapon damage + 45 and generate 1 combo point.',
            handler: (sim, ability) => {
                const base = sim.rollWeaponDamage(1.05) + 45 + sim.getAttackPowerContribution(1.2);
                sim.performYellowDamage({
                    ability,
                    baseDamage: base,
                    comboPointsGenerated: 1,
                });
            },
        }));
        abilityList.push(new Ability({
            id: 'backstab',
            name: 'Backstab',
            icon: '🌀',
            hotkey: '2',
            energyCost: 60,
            comboPoints: 2,
            description: 'A powerful strike that deals 150% weapon damage and awards 2 combo points.',
            handler: (sim, ability) => {
                const base = sim.rollWeaponDamage(1.5) + sim.getAttackPowerContribution(1.7);
                sim.performYellowDamage({
                    ability,
                    baseDamage: base,
                    comboPointsGenerated: 2,
                    critBonus: 5,
                });
            },
        }));
        abilityList.push(new Ability({
            id: 'eviscerate',
            name: 'Eviscerate',
            icon: '💥',
            hotkey: '3',
            energyCost: 35,
            comboPoints: 0,
            description: 'Finishing move that consumes combo points to deal high damage.',
            handler: (sim, ability) => {
                const combo = sim.state.comboPoints;
                if (combo === 0) {
                    sim.ui.addLogEntry('Eviscerate failed: no combo points', 'system');
                    return false;
                }
                const base = 120 + combo * 90 + sim.getAttackPowerContribution(0.4 * combo);
                sim.performYellowDamage({
                    ability,
                    baseDamage: base,
                    comboPointsSpent: combo,
                });
                return true;
            },
        }));
        abilityList.push(new Ability({
            id: 'sliceAndDice',
            name: 'Slice and Dice',
            icon: '⚔️',
            hotkey: '4',
            energyCost: 25,
            comboPoints: 0,
            description: 'Finisher that increases attack speed. Duration scales with combo points.',
            handler: (sim, ability) => {
                const combo = sim.state.comboPoints;
                if (combo === 0) {
                    sim.ui.addLogEntry('Slice and Dice requires combo points.', 'system');
                    return false;
                }
                const duration = 6 + combo * 3;
                sim.applyBuff({
                    id: 'sliceAndDice',
                    name: 'Slice and Dice',
                    duration,
                    type: 'buff',
                    icon: '⚔️',
                    onApply: () => sim.addModifier('autoSpeed', 'sliceAndDice', 0.4),
                    onExpire: () => sim.removeModifier('autoSpeed', 'sliceAndDice'),
                });
                sim.consumeComboPoints(combo);
                sim.onComboPointsSpent(ability, combo);
                sim.ui.addLogEntry(`Slice and Dice refreshed for ${duration}s`, 'system');
                return true;
            },
        }));
        abilityList.push(new Ability({
            id: 'rupture',
            name: 'Rupture',
            icon: '🩸',
            hotkey: '5',
            energyCost: 25,
            comboPoints: 0,
            description: 'Finisher applying a bleed that deals damage over time.',
            handler: (sim, ability) => {
                const combo = sim.state.comboPoints;
                if (combo === 0) {
                    sim.ui.addLogEntry('Rupture requires combo points.', 'system');
                    return false;
                }
                const duration = 8 + combo * 2;
                const tickDamage = 40 + combo * 25 + sim.getAttackPowerContribution(0.12 * combo);
                sim.applyDebuff({
                    id: 'rupture',
                    name: 'Rupture',
                    duration,
                    type: 'debuff',
                    icon: '🩸',
                    tickInterval: 2,
                    onTick: () => {
                        sim.applyDamage(tickDamage, { ability, isDot: true });
                    },
                });
                sim.consumeComboPoints(combo);
                sim.onComboPointsSpent(ability, combo);
                return true;
            },
        }));
        abilityList.push(new Ability({
            id: 'hemorrhage',
            name: 'Hemorrhage',
            icon: '🩸',
            hotkey: '6',
            energyCost: 35,
            comboPoints: 1,
            description: 'Deals extra weapon damage and applies a bleed weakness increasing damage taken.',
            handler: (sim, ability) => {
                const base = sim.rollWeaponDamage(1.1) + 55 + sim.getAttackPowerContribution(1.1);
                const hit = sim.performYellowDamage({
                    ability,
                    baseDamage: base,
                    comboPointsGenerated: 1,
                });
                if (!hit) {
                    return;
                }
                sim.applyDebuff({
                    id: 'hemorrhage',
                    name: 'Hemorrhage',
                    duration: 15,
                    type: 'debuff',
                    icon: '🩸',
                    onApply: () => sim.addModifier('damage', 'hemorrhage', 0.04),
                    onExpire: () => sim.removeModifier('damage', 'hemorrhage'),
                });
                sim.ui.addLogEntry('Hemorrhage weakens the target!', 'system');
            },
        }));
        abilityList.push(new Ability({
            id: 'envenom',
            name: 'Envenom',
            icon: '☠️',
            hotkey: '7',
            energyCost: 35,
            comboPoints: 0,
            description: 'Finishing move that consumes combo points to deal poison damage and sharpen critical strikes.',
            handler: (sim, ability) => {
                const combo = sim.state.comboPoints;
                if (combo === 0) {
                    sim.ui.addLogEntry('Envenom requires combo points.', 'system');
                    return false;
                }
                const base = 90 + combo * 75 + sim.getAttackPowerContribution(0.3 * combo);
                const hit = sim.performYellowDamage({
                    ability,
                    baseDamage: base,
                    comboPointsSpent: combo,
                });
                if (!hit) {
                    return false;
                }
                const critBonus = combo * 3;
                const duration = 2 + combo * 2;
                sim.applyBuff({
                    id: 'envenom',
                    name: 'Envenom',
                    duration,
                    type: 'buff',
                    icon: '☠️',
                    onApply: () => sim.addModifier('critChance', 'envenom', critBonus),
                    onExpire: () => sim.removeModifier('critChance', 'envenom'),
                });
                sim.ui.addLogEntry(`Envenom grants +${critBonus}% crit chance for ${duration}s`, 'system');
                return true;
            },
        }));
        abilityList.push(new Ability({
            id: 'exposeArmor',
            name: 'Expose Armor',
            icon: '🛡️',
            hotkey: 'q',
            energyCost: 25,
            comboPoints: 0,
            description: 'Weakens the dummy, increasing physical damage taken by 8%. Requires combo points.',
            handler: (sim, ability) => {
                const combo = sim.state.comboPoints;
                if (combo === 0) {
                    sim.ui.addLogEntry('Expose Armor requires combo points.', 'system');
                    return false;
                }
                const duration = 12 + combo * 3;
                sim.applyDebuff({
                    id: 'exposeArmor',
                    name: 'Expose Armor',
                    duration,
                    type: 'debuff',
                    armorReduction: 0.08,
                    icon: '🛡️',
                });
                sim.consumeComboPoints(combo);
                sim.onComboPointsSpent(ability, combo);
                sim.ui.addLogEntry(`Expose Armor applied for ${duration}s`, 'system');
                return true;
            },
        }));
        abilityList.push(new Ability({
            id: 'adrenalineRush',
            name: 'Adrenaline Rush',
            icon: '🔥',
            hotkey: 'e',
            energyCost: 0,
            comboPoints: 0,
            cooldown: 180,
            triggersGcd: false,
            description: 'Doubles energy regeneration for 15 seconds. 3 minute cooldown.',
            handler: (sim) => {
                sim.applyBuff({
                    id: 'adrenalineRush',
                    name: 'Adrenaline Rush',
                    duration: 15,
                    type: 'buff',
                    icon: '🔥',
                    onApply: () => sim.addModifier('energyRegen', 'adrenalineRush', 1),
                    onExpire: () => sim.removeModifier('energyRegen', 'adrenalineRush'),
                });
                sim.ui.addLogEntry('Adrenaline Rush activated!', 'system');
            },
        }));
        abilityList.push(new Ability({
            id: 'shadowFocus',
            name: 'Shadow Focus',
            icon: '🌑',
            hotkey: 'r',
            energyCost: 0,
            comboPoints: 0,
            cooldown: 45,
            description: 'Concentrate to instantly regain 40 energy over 4 seconds.',
            handler: (sim, ability) => {
                sim.applyBuff({
                    id: 'shadowFocus',
                    name: 'Shadow Focus',
                    duration: 4,
                    type: 'buff',
                    icon: '🌑',
                    tickInterval: 1,
                    onTick: () => sim.refillEnergy(10),
                });
                sim.ui.addLogEntry('Shadow Focus channels energy regeneration.', 'system');
            },
        }));
        abilityList.push(new Ability({
            id: 'bladeFlurry',
            name: 'Blade Flurry',
            icon: '🌀',
            hotkey: 't',
            energyCost: 25,
            comboPoints: 0,
            cooldown: 120,
            triggersGcd: false,
            description: 'Unleash relentless strikes, increasing attack speed and damage for 12 seconds.',
            handler: (sim) => {
                sim.applyBuff({
                    id: 'bladeFlurry',
                    name: 'Blade Flurry',
                    duration: 12,
                    type: 'buff',
                    icon: '🌀',
                    onApply: () => {
                        sim.addModifier('autoSpeed', 'bladeFlurry', 0.2);
                        sim.addModifier('damage', 'bladeFlurry', 0.2);
                    },
                    onExpire: () => {
                        sim.removeModifier('autoSpeed', 'bladeFlurry');
                        sim.removeModifier('damage', 'bladeFlurry');
                    },
                });
                sim.ui.addLogEntry('Blade Flurry activated!', 'system');
            },
        }));
        return abilityList;
    }
    startLoop() {
        const loop = (timestamp) => {
            const delta = (timestamp - this.lastTimestamp) / 1000;
            this.lastTimestamp = timestamp;
            this.update(delta);
            this.loopHandle = requestAnimationFrame(loop);
        };
        this.loopHandle = requestAnimationFrame(loop);
    }
    pause() {
        if (this.loopHandle !== null) {
            cancelAnimationFrame(this.loopHandle);
            this.loopHandle = null;
        }
    }
    resume() {
        if (this.loopHandle !== null)
            return;
        this.lastTimestamp = performance.now();
        this.startLoop();
    }
    update(delta) {
        let remaining = Math.max(delta, 0);
        const maxStep = 0.5;
        while (remaining > 0) {
            const step = Math.min(remaining, maxStep);
            this.state.globalCooldown = Math.max(0, this.state.globalCooldown - step);
            this.updateCooldowns(step);
            if (this.state.inCombat) {
                this.state.stats.combatTime += step;
                this.updateBuffs(step);
                this.handleEnergy(step);
                this.handleAutoAttack(step);
                this.updateDpsHistory();
            }
            remaining -= step;
        }
        const currentDps = this.getCurrentDps();
        this.ui.updateResources(this.state);
        this.ui.updateDummy(this.state);
        this.ui.updateBuffTimers([...this.state.buffs.values()], [...this.state.debuffs.values()]);
        this.ui.updateBuffLists([...this.state.buffs.values()], [...this.state.debuffs.values()]);
        this.ui.updateStats(this.state.stats, currentDps);
        this.ui.updateAbilityBreakdown(this.state.stats.abilityUsage, this.state.stats.totalDamage);
        this.ui.updateForecast(this.getEnergyForecasts());
        this.ui.updateCombatTimer(this.state.stats.combatTime);
        this.ui.updateSessionComparison(this.previousSession, this.currentSession);
        this.ui.updateAbilityCooldowns(this.state.cooldowns);
        this.ui.updateDpsGraph(this.state.stats.dpsHistory);
    }
    updateConfig(newConfig = {}) {
        const merged = this.applyConfigDefaults(newConfig);
        merged.procs = this.procSystem.updateConfig(merged.procs);
        this.config = merged;
        this.state.maxEnergy = this.config.regen.maxEnergy;
        this.state.energy = Math.min(this.state.energy, this.state.maxEnergy);
        if (!this.state.inCombat) {
            this.state.energy = this.state.maxEnergy;
        }
    }
    castAbility(id) {
        const ability = this.abilities.find(spell => spell.id === id);
        if (!ability)
            return;
        if (!this.state.inCombat) {
            this.startCombat();
        }
        if (!ability.canUse(this))
            return;
        ability.execute(this);
    }
    startCombat() {
        if (this.state.inCombat)
            return;
        this.state.inCombat = true;
        this.state.cooldowns.clear();
        this.state.stats.combatTime = 0;
        this.state.stats.totalDamage = 0;
        this.state.stats.hitCount = 0;
        this.state.stats.critCount = 0;
        this.state.stats.abilityUsage.clear();
        this.state.stats.dpsHistory = [];
        this.state.comboPoints = 0;
        this.state.energy = this.state.maxEnergy;
        if (this.externalTarget) {
            this.externalTarget.onCombatStart?.();
            this.state.dummyMaxHealth = this.externalTarget.getMaxHealth();
            this.state.dummyHealth = this.externalTarget.getCurrentHealth();
        }
        else {
            this.state.dummyHealth = this.state.dummyMaxHealth;
        }
        this.state.autoAttackTimer = this.state.baseAutoSpeed;
        this.state.energyTickProgress = 0;
        this.ui.addLogEntry('Combat started!', 'system');
    }
    stopCombat() {
        if (!this.state.inCombat)
            return;
        this.state.inCombat = false;
        this.state.globalCooldown = 0;
        this.clearEffects();
        this.externalTarget?.onCombatEnd?.();
        const session = {
            damage: this.state.stats.totalDamage,
            duration: Math.max(this.state.stats.combatTime, 1),
            dps: this.getCurrentDps(),
        };
        this.previousSession = this.currentSession;
        this.currentSession = session;
        this.sessionHistory.push(session);
        this.ui.addLogEntry('Combat ended.', 'system');
        if (!this.externalTarget) {
            this.state.dummyHealth = this.state.dummyMaxHealth;
        }
    }
    reset() {
        this.state.inCombat = false;
        this.state.energy = this.state.maxEnergy;
        this.state.comboPoints = 0;
        this.state.globalCooldown = 0;
        if (this.externalTarget) {
            this.externalTarget.onReset?.();
            this.state.dummyMaxHealth = this.externalTarget.getMaxHealth();
            this.state.dummyHealth = this.externalTarget.getCurrentHealth();
        }
        else {
            this.state.dummyHealth = this.state.dummyMaxHealth;
        }
        this.state.autoAttackTimer = this.state.baseAutoSpeed;
        this.state.energyTickProgress = 0;
        this.clearEffects();
        this.state.cooldowns.clear();
        this.state.stats = {
            totalDamage: 0,
            hitCount: 0,
            critCount: 0,
            combatTime: 0,
            dpsHistory: [],
            abilityUsage: new Map(),
        };
        this.ui.addLogEntry('Simulator reset.', 'system');
    }
    triggerGlobalCooldown() {
        this.state.globalCooldown = this.config.general.globalCooldown;
    }
    setCooldown(id, duration) {
        this.state.cooldowns.set(id, duration);
    }
    updateCooldowns(delta) {
        const rate = this.getCooldownRateMultiplier();
        for (const [id, remaining] of [...this.state.cooldowns.entries()]) {
            const next = remaining - delta * rate;
            if (next <= 0) {
                this.state.cooldowns.delete(id);
            }
            else {
                this.state.cooldowns.set(id, next);
            }
        }
    }
    updateBuffs(delta) {
        const updateMap = (map) => {
            for (const [id, buff] of [...map.entries()]) {
                buff.remaining -= delta;
                if (buff.tickInterval) {
                    buff.tickProgress = (buff.tickProgress || 0) + delta;
                    if (buff.tickProgress >= buff.tickInterval) {
                        buff.tickProgress -= buff.tickInterval;
                        buff.onTick?.();
                    }
                }
                if (buff.remaining <= 0) {
                    buff.onExpire?.();
                    map.delete(id);
                    this.ui.addLogEntry(`${buff.name} faded.`, 'system');
                }
                else {
                    map.set(id, buff);
                }
            }
        };
        updateMap(this.state.buffs);
        updateMap(this.state.debuffs);
    }
    handleEnergy(delta) {
        const regenPerTick = this.config.regen.energyPerTick * (1 + this.config.regen.talentBonus);
        const tickInterval = this.config.regen.tickInterval;
        const multiplier = this.getEnergyRegenMultiplier();
        this.state.energyTickProgress += delta;
        while (this.state.energyTickProgress >= tickInterval) {
            this.state.energyTickProgress -= tickInterval;
            const baseGain = regenPerTick * multiplier;
            this.refillEnergy(baseGain);
        }
    }
    handleAutoAttack(delta) {
        const interval = this.state.baseAutoSpeed / this.getAutoSpeedMultiplier();
        this.state.autoAttackTimer -= delta;
        if (this.state.autoAttackTimer <= 0) {
            this.performAutoAttack();
            this.state.autoAttackTimer += interval;
        }
    }
    performAutoAttack() {
        const base = this.rollWeaponDamage(1) + this.getAttackPowerContribution(1.2);
        this.performWhiteDamage(base);
    }
    performWhiteDamage(baseDamage) {
        if (!this.rollHit()) {
            this.ui.addLogEntry('Auto Attack missed!', 'auto');
            return;
        }
        const isCrit = this.rollCrit(this.config.stats.critChance);
        const damage = this.applyDamageModifiers(baseDamage, isCrit);
        this.applyDamage(damage, { ability: { name: 'Auto Attack', id: 'auto' }, isCrit, isAuto: true });
        if (this.config.talents?.shadowTechniques) {
            if (Math.random() <= 0.3) {
                this.addComboPoints(1);
                this.ui.addLogEntry('Shadow Techniques grants an extra combo point!', 'system');
                this.ui.showFloatingText('+1 Combo', 'combo');
            }
        }
    }
    performYellowDamage({ ability, baseDamage, comboPointsGenerated = 0, comboPointsSpent = 0, critBonus = 0 }) {
        if (!this.rollHit()) {
            this.ui.addLogEntry(`${ability.name} missed!`, 'system');
            return false;
        }
        let critChance = this.config.stats.critChance + critBonus;
        const isFinisher = comboPointsSpent > 0;
        if (isFinisher && this.config.talents?.precisionStrikes) {
            critChance += 5;
        }
        const isCrit = this.rollCrit(critChance);
        let damage = this.applyDamageModifiers(baseDamage, isCrit);
        if (isFinisher && this.config.talents?.precisionStrikes) {
            damage *= 1.08;
        }
        this.applyDamage(damage, { ability, isCrit });
        if (comboPointsGenerated) {
            this.addComboPoints(comboPointsGenerated);
        }
        if (comboPointsSpent) {
            this.consumeComboPoints(comboPointsSpent);
            this.onComboPointsSpent(ability, comboPointsSpent);
        }
        return true;
    }
    onComboPointsSpent(ability, amount) {
        if (!amount)
            return;
        if (this.config.talents?.relentlessStrikes) {
            const refund = Math.round(8 + amount * 3);
            if (refund > 0) {
                this.refillEnergy(refund);
                this.ui.addLogEntry(`Relentless Strikes refunds ${refund} energy after using ${ability.name}.`, 'system');
                this.ui.showFloatingText(`+${refund} Energy`, 'energy');
            }
        }
    }
    // Fix: Correctly type the optional, destructured parameter.
    applyDamage(amount, { ability, isCrit = false, isAuto = false, isDot = false } = {}) {
        const damage = Math.round(amount);
        if (damage <= 0)
            return;
        if (this.externalTarget) {
            this.externalTarget.applyDamage(damage, { ability, isCrit, isAuto, isDot });
            this.state.dummyMaxHealth = this.externalTarget.getMaxHealth();
            this.state.dummyHealth = Math.max(0, this.externalTarget.getCurrentHealth());
        }
        else {
            this.state.dummyHealth = Math.max(0, this.state.dummyHealth - damage);
        }
        this.state.stats.totalDamage += damage;
        this.state.stats.hitCount += 1;
        if (isCrit)
            this.state.stats.critCount += 1;
        const entryType = isCrit ? 'crit' : isAuto ? 'auto' : 'ability';
        const label = ability ? ability.name : 'Damage';
        const critLabel = isCrit ? ' (CRIT!)' : '';
        const dotLabel = isDot ? ' (DoT)' : '';
        this.ui.addLogEntry(`${label}${dotLabel}: ${damage}${critLabel}`, entryType);
        if (!isDot) {
            this.ui.flashDummy();
            this.ui.showDamageNumber(damage, { isCrit, isAuto });
        }
        if (ability) {
            this.incrementAbilityUsage(ability, damage);
        }
        this.procSystem.handleEvent('damage', { ability, isCrit, isAuto, isDot, damage });
        if (this.state.dummyHealth <= 0) {
            if (this.externalTarget) {
                this.ui.addLogEntry('Target defeated!', 'system');
                this.externalTarget.onDefeated?.();
                this.stopCombat();
            }
            else {
                this.ui.addLogEntry('Dummy defeated!', 'system');
                this.stopCombat();
                this.state.dummyHealth = this.state.dummyMaxHealth;
            }
        }
    }
    incrementAbilityUsage(ability, damage) {
        const usage = this.state.stats.abilityUsage.get(ability.name) || { count: 0, damage: 0 };
        usage.count += 1;
        usage.damage += damage;
        this.state.stats.abilityUsage.set(ability.name, usage);
    }
    rollWeaponDamage(multiplier = 1) {
        const { weaponMin, weaponMax } = this.config.stats;
        const lower = Math.min(weaponMin, weaponMax);
        const upper = Math.max(weaponMin, weaponMax);
        const span = upper - lower;
        const roll = span <= 0 ? lower : lower + Math.random() * span;
        return roll * multiplier;
    }
    getAttackPowerContribution(scaling) {
        return (this.config.stats.attackPower / 14) * scaling;
    }
    rollHit() {
        const bonus = this.getTalentHitBonus();
        const hitChance = Math.min(Math.max(this.config.stats.hitChance + bonus, 0), 100) / 100;
        return Math.random() <= hitChance;
    }
    rollCrit(chance) {
        const totalChance = Math.min(Math.max(chance + this.getCritChanceBonus(), 0), 100) / 100;
        return Math.random() <= totalChance;
    }
    getTalentHitBonus() {
        let bonus = 0;
        if (this.config.talents?.precisionStrikes) {
            bonus += 3;
        }
        return bonus;
    }
    applyDamageModifiers(baseDamage, isCrit) {
        let damage = baseDamage;
        const expose = this.state.debuffs.get('exposeArmor');
        if (expose?.armorReduction) {
            damage *= 1 + expose.armorReduction;
        }
        if (isCrit)
            damage *= 2;
        damage *= this.getDamageMultiplier();
        return damage;
    }
    spendEnergy(amount) {
        this.state.energy = Math.max(0, this.state.energy - amount);
    }
    refundEnergy(amount) {
        this.state.energy = Math.min(this.state.maxEnergy, this.state.energy + amount);
    }
    refillEnergy(amount) {
        const before = this.state.energy;
        this.state.energy = Math.min(this.state.maxEnergy, this.state.energy + amount);
        if (this.state.energy > before && this.state.energy === this.state.maxEnergy) {
            this.ui.addLogEntry('Energy capped!', 'system');
        }
    }
    addComboPoints(amount) {
        this.state.comboPoints = Math.min(this.state.maxComboPoints, this.state.comboPoints + amount);
    }
    consumeComboPoints(amount) {
        this.state.comboPoints = Math.max(0, this.state.comboPoints - amount);
    }
    addModifier(type, id, value) {
        const bucket = this.state.modifiers[type];
        if (!bucket)
            return;
        bucket.set(id, value);
    }
    removeModifier(type, id) {
        const bucket = this.state.modifiers[type];
        bucket?.delete(id);
    }
    getModifierTotal(type) {
        const bucket = this.state.modifiers[type];
        if (!bucket)
            return 0;
        let total = 0;
        bucket.forEach(value => {
            total += value;
        });
        return total;
    }
    getAutoSpeedMultiplier() {
        return Math.max(0.1, 1 + this.getModifierTotal('autoSpeed'));
    }
    getEnergyRegenMultiplier() {
        return Math.max(0, 1 + this.getModifierTotal('energyRegen'));
    }
    getDamageMultiplier() {
        return Math.max(0, 1 + this.getModifierTotal('damage'));
    }
    getCritChanceBonus() {
        return this.getModifierTotal('critChance');
    }
    getCooldownRateMultiplier() {
        return Math.max(0, 1 + this.getModifierTotal('cooldownRate'));
    }
    applyBuff(buff) {
        if (this.state.buffs.has(buff.id)) {
            this.state.buffs.get(buff.id).onExpire?.();
        }
        const enriched = { ...buff, remaining: buff.duration };
        this.state.buffs.set(buff.id, enriched);
        enriched.onApply?.();
    }
    removeBuff(id) {
        const existing = this.state.buffs.get(id);
        if (existing) {
            existing.onExpire?.();
            this.state.buffs.delete(id);
        }
    }
    applyDebuff(debuff) {
        if (this.state.debuffs.has(debuff.id)) {
            this.state.debuffs.get(debuff.id).onExpire?.();
        }
        const enriched = { ...debuff, remaining: debuff.duration };
        this.state.debuffs.set(debuff.id, enriched);
        enriched.onApply?.();
    }
    clearEffects() {
        this.state.buffs.forEach(buff => buff.onExpire?.());
        this.state.debuffs.forEach(debuff => debuff.onExpire?.());
        this.state.buffs.clear();
        this.state.debuffs.clear();
        // Fix: Cast map to access .clear() method.
        Object.values(this.state.modifiers).forEach(map => map.clear());
    }
    getCurrentDps() {
        const time = Math.max(this.state.stats.combatTime, 1);
        return this.state.stats.totalDamage / time;
    }
    updateDpsHistory() {
        const time = this.state.stats.combatTime;
        if (this.state.stats.dpsHistory.length === 0 || time - this.state.stats.dpsHistory[this.state.stats.dpsHistory.length - 1].time >= 1) {
            this.state.stats.dpsHistory.push({ time, dps: this.getCurrentDps() });
            if (this.state.stats.dpsHistory.length > 120) {
                this.state.stats.dpsHistory.shift();
            }
        }
    }
    getEnergyForecasts() {
        const regenPerSecond = this.getAverageEnergyPerSecond();
        const forecast = (seconds) => Math.min(this.state.maxEnergy, Math.round(this.state.energy + regenPerSecond * seconds));
        return {
            in1s: forecast(1),
            in3s: forecast(3),
            in5s: forecast(5),
        };
    }
    getAverageEnergyPerSecond() {
        const base = (this.config.regen.energyPerTick * (1 + this.config.regen.talentBonus)) / this.config.regen.tickInterval;
        return base * this.getEnergyRegenMultiplier();
    }
}
const simulatorUi = new UIController();
const simulator = new RogueSimulator(simulatorUi);
simulatorUi.bindSimulator(simulator);
const arpgUi = new ActionRpgUIController();
const arpgSimulator = new RogueSimulator(arpgUi);
arpgUi.bindSimulator(arpgSimulator);
arpgSimulator.pause();
arpgUi.detachHotkeyListeners();
const arpgCanvas = document.getElementById('arpg-canvas');
const arpgGame = new ActionRpgGame(arpgCanvas, arpgUi, arpgSimulator);
arpgGame.stop();
const modeButtons = {
    simulator: document.getElementById('switchSimulator'),
    arpg: document.getElementById('switchArpg'),
};
const simulatorMode = document.getElementById('simulatorMode');
const arpgMode = document.getElementById('arpgMode');
let activeMode = 'simulator';
function setActiveMode(mode) {
    if (mode === activeMode)
        return;
    if (mode === 'simulator') {
        document.body.classList.remove('mode-arpg');
        document.body.classList.add('mode-simulator');
        simulatorMode.classList.add('active');
        arpgMode.classList.remove('active');
        modeButtons.simulator.classList.add('active');
        modeButtons.arpg.classList.remove('active');
        arpgGame.stop();
        arpgSimulator.removeBuff('stealth');
        arpgGame.player.stealth = false;
        arpgSimulator.pause();
        arpgUi.detachHotkeyListeners();
        arpgUi.showRangeWarning('');
        simulator.resume();
        simulatorUi.attachHotkeyListeners();
    }
    else {
        document.body.classList.remove('mode-simulator');
        document.body.classList.add('mode-arpg');
        simulatorMode.classList.remove('active');
        arpgMode.classList.add('active');
        modeButtons.simulator.classList.remove('active');
        modeButtons.arpg.classList.add('active');
        simulator.pause();
        simulatorUi.detachHotkeyListeners();
        arpgSimulator.resume();
        arpgUi.attachHotkeyListeners();
        arpgGame.start();
    }
    activeMode = mode;
}
modeButtons.simulator.addEventListener('click', () => setActiveMode('simulator'));
modeButtons.arpg.addEventListener('click', () => setActiveMode('arpg'));
document.body.classList.add('mode-simulator');
simulatorMode.classList.add('active');
arpgMode.classList.remove('active');
modeButtons.simulator.classList.add('active');
modeButtons.arpg.classList.remove('active');
