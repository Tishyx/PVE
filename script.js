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
        } catch (error) {
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
        condition: (context) => !context.isDot,
        onTrigger: (sim, config) => {
            const energy = Math.max(0, Number(config.energyGain) || 0);
            let log = 'Energy Surge triggered!';
            let floatingText = 'Energy Surge!';
            let floatingType = 'proc';
            if (energy > 0) {
                sim.refillEnergy(energy);
                log = `Energy Surge restores ${energy} energy!`;
                floatingText = `+${energy} Energy`;
                floatingType = 'energy';
            } else {
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
        condition: (context) => context.isCrit && !context.isDot,
        onTrigger: (sim, config) => {
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
        condition: (context) => !context.isAuto && !context.isDot,
        onTrigger: (sim, config) => {
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
        condition: (context) => !context.isDot,
        onTrigger: (sim, config) => {
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
        condition: (context) => !context.isAuto && !context.isDot,
        onTrigger: (sim, config) => {
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
            if (!config?.enabled) return;
            if (!def.events.includes(event)) return;
            if (def.condition && !def.condition(context, config, this.simulator)) return;
            const chance = Number(config.chance ?? def.defaultConfig?.chance ?? 0);
            if (chance <= 0) return;
            if (Math.random() * 100 > chance) return;
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
    constructor() {
        this.elements = {
            dummyHealthBar: document.getElementById('dummyHealthBar'),
            dummyHealthText: document.getElementById('dummyHealthText'),
            dummyModel: document.getElementById('dummyModel'),
            energyBar: document.getElementById('energyBar'),
            energyText: document.getElementById('energyText'),
            comboPoints: Array.from(document.querySelectorAll('#comboPoints .combo-point')),
            buffTimers: document.getElementById('buffTimers'),
            buffList: document.getElementById('buffList'),
            debuffList: document.getElementById('debuffList'),
            combatLog: document.getElementById('combatLog'),
            actionBar: document.getElementById('actionBar'),
            floatingTextContainer: document.getElementById('floatingTextContainer'),
            currentDPS: document.getElementById('currentDPS'),
            totalDamage: document.getElementById('totalDamage'),
            averageDPS: document.getElementById('averageDPS'),
            hitCount: document.getElementById('hitCount'),
            critCount: document.getElementById('critCount'),
            nextAbility: document.getElementById('nextAbility'),
            nextAbilityReason: document.getElementById('nextAbilityReason'),
            forecast1: document.getElementById('forecast1'),
            forecast3: document.getElementById('forecast3'),
            forecast5: document.getElementById('forecast5'),
            combatTimer: document.getElementById('combatTimer'),
            previousDps: document.getElementById('previousDps'),
            currentDpsCompare: document.getElementById('currentDpsCompare'),
            dpsDelta: document.getElementById('dpsDelta'),
            dpsGraph: document.getElementById('dpsGraph'),
        };

        this.tooltip = document.getElementById('tooltip');
        this.forms = {
            attackPower: document.getElementById('attackPower'),
            weaponMin: document.getElementById('weaponMin'),
            weaponMax: document.getElementById('weaponMax'),
            critChance: document.getElementById('critChance'),
            hitChance: document.getElementById('hitChance'),
            tickInterval: document.getElementById('tickInterval'),
            energyPerTick: document.getElementById('energyPerTick'),
            talentBonus: document.getElementById('talentBonus'),
            buildName: document.getElementById('buildName'),
            buildSelect: document.getElementById('buildSelect'),
        };

        this.buttons = {
            saveBuild: document.getElementById('saveBuild'),
            loadBuild: document.getElementById('loadBuild'),
            deleteBuild: document.getElementById('deleteBuild'),
            startCombat: document.getElementById('startCombat'),
            stopCombat: document.getElementById('stopCombat'),
            resetCombat: document.getElementById('resetCombat'),
        };

        /** @type {RogueSimulator | null} */
        this.simulator = null;
        this.soundPlayer = new SoundPlayer();
        this.procInputs = new Map();
        this.procConfigContainer = document.getElementById('procConfig');
    }

    bindSimulator(simulator) {
        this.simulator = simulator;
        const formInputs = Object.values(this.forms).filter(el => el instanceof HTMLInputElement || el instanceof HTMLSelectElement);
        const procInputs = this.getProcInputElements();
        [...formInputs, ...procInputs].forEach(input => {
            input.addEventListener('change', () => {
                simulator.updateConfig(this.getConfigFromInputs());
            });
        });

        this.buttons.saveBuild.addEventListener('click', () => {
            const name = this.forms.buildName.value.trim();
            simulator.saveBuild(name);
        });
        this.buttons.loadBuild.addEventListener('click', () => {
            const id = this.forms.buildSelect.value;
            simulator.loadBuild(id);
        });
        this.buttons.deleteBuild.addEventListener('click', () => {
            const id = this.forms.buildSelect.value;
            simulator.deleteBuild(id);
        });
        this.buttons.startCombat.addEventListener('click', () => simulator.startCombat());
        this.buttons.stopCombat.addEventListener('click', () => simulator.stopCombat());
        this.buttons.resetCombat.addEventListener('click', () => simulator.reset());
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
        return {
            stats: {
                attackPower: Math.max(0, Number(this.forms.attackPower.value) || 0),
                weaponMin: Math.max(0, Number(this.forms.weaponMin.value) || 0),
                weaponMax: Math.max(0, Number(this.forms.weaponMax.value) || 0),
                critChance: clamp(Number(this.forms.critChance.value) || 0, 0, 100),
                hitChance: clamp(Number(this.forms.hitChance.value) || 0, 0, 100),
            },
            regen: {
                tickInterval: Math.max(0.1, Number(this.forms.tickInterval.value) || 2000) / 1000,
                energyPerTick: Math.max(0, Number(this.forms.energyPerTick.value) || 0),
                talentBonus: Math.max(0, Number(this.forms.talentBonus.value) || 0) / 100,
            },
            general: {
                globalCooldown: 1.0,
            },
            procs: procConfig,
        };
    }

    setConfigInputs(config) {
        const { stats, regen, procs } = config;
        this.forms.attackPower.value = stats.attackPower;
        this.forms.weaponMin.value = stats.weaponMin;
        this.forms.weaponMax.value = stats.weaponMax;
        this.forms.critChance.value = stats.critChance;
        this.forms.hitChance.value = stats.hitChance;
        this.forms.tickInterval.value = Math.round(regen.tickInterval * 1000);
        this.forms.energyPerTick.value = regen.energyPerTick;
        this.forms.talentBonus.value = Math.round(regen.talentBonus * 100);
        if (procs) {
            Object.entries(procs).forEach(([id, values]) => {
                const inputs = this.procInputs.get(id);
                if (!inputs) return;
                inputs.enabled.checked = Boolean(values.enabled);
                inputs.fields.forEach((input, key) => {
                    if (key in values) {
                        input.value = values[key];
                    }
                });
                inputs.updateDisabled?.();
            });
        }
    }

    populateBuildSelect(builds) {
        this.forms.buildSelect.innerHTML = '';
        if (builds.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No builds saved';
            this.forms.buildSelect.appendChild(option);
            return;
        }
        builds.forEach((build, index) => {
            const option = document.createElement('option');
            option.value = build.id;
            option.textContent = `${build.name} (${build.config.stats.attackPower} AP)`;
            if (index === 0) option.selected = true;
            this.forms.buildSelect.appendChild(option);
        });
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
            button.addEventListener('click', () => this.simulator?.castAbility(ability.id));
            button.addEventListener('mouseenter', (event) => this.showTooltip(event, ability));
            button.addEventListener('mouseleave', () => this.hideTooltip());
            this.elements.actionBar.appendChild(button);
        });
    }

    showTooltip(event, ability) {
        const { currentTarget } = event;
        if (!(currentTarget instanceof HTMLElement)) return;
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
        if (!this.procConfigContainer) return;
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
                if (typeof field.min === 'number') input.min = String(field.min);
                if (typeof field.max === 'number') input.max = String(field.max);
                if (typeof field.step === 'number') input.step = String(field.step);
                input.value = procConfig?.[field.key] ?? field.defaultValue ?? 0;
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

    showFloatingText(message, type = 'proc') {
        const container = this.elements.floatingTextContainer;
        if (!container) return;
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
        this.elements.hitCount.textContent = stats.hitCount;
        this.elements.critCount.textContent = stats.critCount;
        this.elements.currentDPS.textContent = Math.floor(currentDps);
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

    updateRotationCoach(advice) {
        this.elements.nextAbility.textContent = advice.ability;
        this.elements.nextAbilityReason.textContent = advice.reason;
    }

    updateSessionComparison(previous, current) {
        if (previous) {
            this.elements.previousDps.textContent = `${previous.dps.toFixed(1)} (${previous.duration.toFixed(1)}s)`;
        } else {
            this.elements.previousDps.textContent = '-';
        }
        if (current) {
            this.elements.currentDpsCompare.textContent = `${current.dps.toFixed(1)} (${current.duration.toFixed(1)}s)`;
        } else {
            this.elements.currentDpsCompare.textContent = '-';
        }
        if (previous && current) {
            const delta = current.dps - previous.dps;
            const sign = delta > 0 ? '+' : '';
            this.elements.dpsDelta.textContent = `${sign}${delta.toFixed(1)}`;
            this.elements.dpsDelta.style.color = delta >= 0 ? '#6bff98' : '#ff8686';
        } else {
            this.elements.dpsDelta.textContent = '-';
            this.elements.dpsDelta.style.color = '#f4f6fb';
        }
    }

    updateAbilityCooldowns(cooldowns) {
        const buttons = Array.from(this.elements.actionBar.querySelectorAll('.ability-button'));
        buttons.forEach(btn => {
            const abilityId = btn.dataset.ability;
            const remaining = cooldowns.get(abilityId);
            if (remaining && remaining > 0.1) {
                btn.classList.add('on-cooldown');
                btn.dataset.cooldown = remaining.toFixed(1);
            } else {
                btn.classList.remove('on-cooldown');
                delete btn.dataset.cooldown;
            }
        });
    }

    updateDpsGraph(history) {
        const ctx = this.elements.dpsGraph.getContext('2d');
        const canvas = this.elements.dpsGraph;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (history.length < 2) return;

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
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
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
        document.addEventListener('keydown', (event) => {
            if (event.repeat) return;
            const target = event.target;
            if (target instanceof Element) {
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
                this.simulator?.castAbility(abilityId);
            }
        });
    }
}

class RogueSimulator {
    constructor(ui) {
        this.ui = ui;
        this.state = {
            inCombat: false,
            energy: 100,
            maxEnergy: 100,
            comboPoints: 0,
            maxComboPoints: 5,
            globalCooldown: 0,
            dummyMaxHealth: 1000000,
            dummyHealth: 1000000,
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
        this.config = this.ui.getConfigFromInputs();
        this.config.procs = this.procSystem.updateConfig(this.config.procs);
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
        this.loadBuilds();
        this.startLoop();
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

    update(delta) {
        if (delta > 0.5) return; // prevent huge jumps on tab switch
        this.state.globalCooldown = Math.max(0, this.state.globalCooldown - delta);
        this.updateCooldowns(delta);
        if (this.state.inCombat) {
            this.state.stats.combatTime += delta;
            this.updateBuffs(delta);
            this.handleEnergy(delta);
            this.handleAutoAttack(delta);
            this.updateDpsHistory();
        }

        const currentDps = this.getCurrentDps();
        this.ui.updateResources(this.state);
        this.ui.updateDummy(this.state);
        this.ui.updateBuffTimers([...this.state.buffs.values()], [...this.state.debuffs.values()]);
        this.ui.updateBuffLists([...this.state.buffs.values()], [...this.state.debuffs.values()]);
        this.ui.updateStats(this.state.stats, currentDps);
        this.ui.updateForecast(this.getEnergyForecasts());
        this.ui.updateCombatTimer(this.state.stats.combatTime);
        this.ui.updateSessionComparison(this.previousSession, this.currentSession);
        this.ui.updateAbilityCooldowns(this.state.cooldowns);
        this.ui.updateDpsGraph(this.state.stats.dpsHistory);
        this.updateRotationAdvice();
    }

    updateConfig(newConfig = {}) {
        const merged = { ...newConfig };
        merged.procs = this.procSystem.updateConfig(newConfig.procs);
        this.config = merged;
    }

    castAbility(id) {
        const ability = this.abilities.find(spell => spell.id === id);
        if (!ability) return;
        if (!this.state.inCombat) {
            this.startCombat();
        }
        if (!ability.canUse(this)) return;
        ability.execute(this);
    }

    startCombat() {
        if (this.state.inCombat) return;
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
        this.state.dummyHealth = this.state.dummyMaxHealth;
        this.state.energyTickProgress = 0;
        this.ui.addLogEntry('Combat started!', 'system');
    }

    stopCombat() {
        if (!this.state.inCombat) return;
        this.state.inCombat = false;
        this.state.globalCooldown = 0;
        this.clearEffects();
        const session = {
            damage: this.state.stats.totalDamage,
            duration: Math.max(this.state.stats.combatTime, 1),
            dps: this.getCurrentDps(),
        };
        this.previousSession = this.currentSession;
        this.currentSession = session;
        this.sessionHistory.push(session);
        this.ui.addLogEntry('Combat ended.', 'system');
    }

    reset() {
        this.state.inCombat = false;
        this.state.energy = this.state.maxEnergy;
        this.state.comboPoints = 0;
        this.state.globalCooldown = 0;
        this.state.dummyHealth = this.state.dummyMaxHealth;
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
            } else {
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
                } else {
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
    }

    performYellowDamage({ ability, baseDamage, comboPointsGenerated = 0, comboPointsSpent = 0, critBonus = 0 }) {
        if (!this.rollHit()) {
            this.ui.addLogEntry(`${ability.name} missed!`, 'system');
            return false;
        }
        const critChance = this.config.stats.critChance + critBonus;
        const isCrit = this.rollCrit(critChance);
        const damage = this.applyDamageModifiers(baseDamage, isCrit);
        this.applyDamage(damage, { ability, isCrit });
        if (comboPointsGenerated) {
            this.addComboPoints(comboPointsGenerated);
        }
        if (comboPointsSpent) {
            this.consumeComboPoints(comboPointsSpent);
        }
        return true;
    }

    applyDamage(amount, { ability, isCrit = false, isAuto = false, isDot = false } = {}) {
        const damage = Math.round(amount);
        if (damage <= 0) return;
        this.state.dummyHealth = Math.max(0, this.state.dummyHealth - damage);
        this.state.stats.totalDamage += damage;
        this.state.stats.hitCount += 1;
        if (isCrit) this.state.stats.critCount += 1;
        const entryType = isCrit ? 'crit' : isAuto ? 'auto' : 'ability';
        const label = ability ? ability.name : 'Damage';
        const critLabel = isCrit ? ' (CRIT!)' : '';
        const dotLabel = isDot ? ' (DoT)' : '';
        this.ui.addLogEntry(`${label}${dotLabel}: ${damage}${critLabel}`, entryType);
        this.ui.flashDummy();
        if (ability) {
            this.incrementAbilityUsage(ability, damage);
        }
        this.procSystem.handleEvent('damage', { ability, isCrit, isAuto, isDot, damage });
        if (this.state.dummyHealth <= 0) {
            this.ui.addLogEntry('Dummy defeated!', 'system');
            this.stopCombat();
            this.state.dummyHealth = this.state.dummyMaxHealth;
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
        const roll = weaponMin + Math.random() * Math.max(weaponMax - weaponMin, 1);
        return roll * multiplier;
    }

    getAttackPowerContribution(scaling) {
        return (this.config.stats.attackPower / 14) * scaling;
    }

    rollHit() {
        const hitChance = this.config.stats.hitChance / 100;
        return Math.random() <= hitChance;
    }

    rollCrit(chance) {
        const totalChance = Math.min(Math.max(chance + this.getCritChanceBonus(), 0), 100) / 100;
        return Math.random() <= totalChance;
    }

    applyDamageModifiers(baseDamage, isCrit) {
        let damage = baseDamage;
        const expose = this.state.debuffs.get('exposeArmor');
        if (expose?.armorReduction) {
            damage *= 1 + expose.armorReduction;
        }
        if (isCrit) damage *= 2;
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
        if (!bucket) return;
        bucket.set(id, value);
    }

    removeModifier(type, id) {
        const bucket = this.state.modifiers[type];
        bucket?.delete(id);
    }

    getModifierTotal(type) {
        const bucket = this.state.modifiers[type];
        if (!bucket) return 0;
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

    updateRotationAdvice() {
        if (!this.state.inCombat) {
            this.ui.updateRotationCoach({ ability: 'Start combat', reason: 'Press Start Combat to begin the simulation.' });
            return;
        }
        let ability = 'Wait';
        let reason = 'Pooling energy';
        if (!this.state.buffs.has('sliceAndDice') && this.state.comboPoints >= 1) {
            ability = 'Slice and Dice';
            reason = 'Maintain attack speed buff';
        } else if (this.state.comboPoints >= 5) {
            ability = this.state.debuffs.has('exposeArmor') ? 'Eviscerate' : 'Expose Armor';
            reason = this.state.debuffs.has('exposeArmor') ? 'Spend max combo points for damage' : 'Apply armor shred';
        } else if (this.state.energy >= 60) {
            ability = 'Backstab';
            reason = 'High energy - generate combo points fast';
        } else if (this.state.energy >= 40) {
            ability = 'Sinister Strike';
            reason = 'Low combo points - builder';
        } else if (!this.state.cooldowns.has('adrenalineRush')) {
            ability = 'Adrenaline Rush';
            reason = 'Low energy - boost regeneration';
        }
        this.ui.updateRotationCoach({ ability, reason });
    }

    getBuildStorage() {
        const raw = localStorage.getItem('rogue-sim-builds');
        return raw ? JSON.parse(raw) : [];
    }

    saveBuild(name) {
        if (!name) {
            this.ui.addLogEntry('Enter a name before saving a build.', 'system');
            return;
        }
        const builds = this.getBuildStorage();
        const config = JSON.parse(JSON.stringify(this.config));
        const id = (globalThis.crypto?.randomUUID?.()) ? crypto.randomUUID() : `build-${Date.now()}`;
        builds.push({ id, name, config });
        localStorage.setItem('rogue-sim-builds', JSON.stringify(builds));
        this.ui.populateBuildSelect(builds);
        this.ui.forms.buildSelect.value = id;
        this.ui.addLogEntry(`Saved build: ${name}`, 'system');
    }

    loadBuild(id) {
        const builds = this.getBuildStorage();
        const build = builds.find(entry => entry.id === id);
        if (!build) {
            this.ui.addLogEntry('No build selected.', 'system');
            return;
        }
        this.config = JSON.parse(JSON.stringify(build.config));
        this.config.procs = this.procSystem.updateConfig(this.config.procs);
        this.ui.setConfigInputs(this.config);
        this.ui.addLogEntry(`Loaded build: ${build.name}`, 'system');
    }

    deleteBuild(id) {
        const builds = this.getBuildStorage();
        const filtered = builds.filter(entry => entry.id !== id);
        localStorage.setItem('rogue-sim-builds', JSON.stringify(filtered));
        this.ui.populateBuildSelect(filtered);
        this.ui.addLogEntry('Build deleted.', 'system');
    }

    loadBuilds() {
        const builds = this.getBuildStorage();
        this.ui.populateBuildSelect(builds);
    }
}

const ui = new UIController();
const simulator = new RogueSimulator(ui);
ui.bindSimulator(simulator);
