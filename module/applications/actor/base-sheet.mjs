import ActiveEffect5e from "../../documents/active-effect.mjs";
import Actor5e from "../../documents/actor/actor.mjs";
import Item5e from "../../documents/item.mjs";

import ActorAbilityConfig from "./ability-config.mjs";
import ActorArmorConfig from "./armor-config.mjs";
import ActorHitDiceConfig from "./hit-dice-config.mjs";
import ActorMovementConfig from "./movement-config.mjs";
import ActorSensesConfig from "./senses-config.mjs";
import ActorSheetFlags from "./sheet-flags.mjs";
import ActorSkillConfig from "./skill-config.mjs";
import ActorTypeConfig from "./type-config.mjs";

import AdvancementConfirmationDialog from "../../advancement/advancement-confirmation-dialog.mjs";
import AdvancementManager from "../../advancement/advancement-manager.mjs";

import ProficiencySelector from "../proficiency-selector.mjs";
import PropertyAttribution from "../property-attribution.mjs";
import TraitSelector from "../trait-selector.mjs";

/**
 * Extend the basic ActorSheet class to suppose system-specific logic and functionality.
 * @abstract
 */
export default class ActorSheet5e extends ActorSheet {

  /**
   * Track the set of item filters which are applied
   * @type {Object<string, Set>}
   * @protected
   */
  _filters = {
    inventory: new Set(),
    spellbook: new Set(),
    features: new Set(),
    effects: new Set()
  };

  /* -------------------------------------------- */

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      scrollY: [
        ".inventory .inventory-list",
        ".features .inventory-list",
        ".spellbook .inventory-list",
        ".effects .inventory-list"
      ],
      tabs: [{navSelector: ".tabs", contentSelector: ".sheet-body", initial: "description"}],
      width: 720,
      height: Math.max(680, Math.max(
        237 + (Object.keys(CONFIG.DND5E.abilities).length * 70),
        240 + (Object.keys(CONFIG.DND5E.skills).length * 24)
      ))
    });
  }

  /* -------------------------------------------- */

  /**
   * A set of item types that should be prevented from being dropped on this type of actor sheet.
   * @type {Set<string>}
   */
  static unsupportedItemTypes = new Set();

  /* -------------------------------------------- */

  /** @override */
  get template() {
    if ( !game.user.isGM && this.actor.limited ) return "systems/dnd5e/templates/actors/limited-sheet.hbs";
    return `systems/dnd5e/templates/actors/${this.actor.type}-sheet.hbs`;
  }

  /* -------------------------------------------- */
  /*  Context Preparation                         */
  /* -------------------------------------------- */

  /** @override */
  async getData(options) {

    // The Actor's data
    const source = this.actor.toObject();
    const actorData = this.actor.toObject(false);

    // Basic data
    const context = {
      actor: actorData,
      source: source.system,
      system: actorData.system,
      items: actorData.items,
      labels: this._getLabels(actorData.system),
      movement: this._getMovementSpeed(actorData.system),
      senses: this._getSenses(actorData.system),
      effects: ActiveEffect5e.prepareActiveEffectCategories(this.actor.effects),
      warnings: this.actor._preparationWarnings,
      filters: this._filters,
      owner: this.actor.isOwner,
      limited: this.actor.limited,
      options: this.options,
      editable: this.isEditable,
      cssClass: this.actor.isOwner ? "editable" : "locked",
      isCharacter: this.actor.type === "character",
      isNPC: this.actor.type === "npc",
      isVehicle: this.actor.type === "vehicle",
      config: CONFIG.DND5E,
      rollData: this.actor.getRollData.bind(this.actor)
    };

    /** @deprecated */
    Object.defineProperty(context, "data", {
      get() {
        const msg = `You are accessing the "data" attribute within the rendering context provided by the ItemSheet5e 
        class. This attribute has been deprecated in favor of "system" and will be removed in a future release`;
        foundry.utils.logCompatibilityWarning(msg, { since: "DnD5e 2.0", until: "DnD5e 2.2" });
        return context.system;
      }
    });

    // Sort Owned Items
    for ( let i of context.items ) {
      const item = this.actor.items.get(i._id);
      i.labels = item.labels;
    }
    context.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));

    // Temporary HP
    const hp = context.system.attributes.hp;
    if ( hp.temp === 0 ) delete hp.temp;
    if ( hp.tempmax === 0 ) delete hp.tempmax;

    // Ability Scores
    for ( const [a, abl] of Object.entries(context.system.abilities) ) {
      abl.icon = this._getProficiencyIcon(abl.proficient);
      abl.hover = CONFIG.DND5E.proficiencyLevels[abl.proficient];
      abl.label = CONFIG.DND5E.abilities[a];
      abl.baseProf = source.system.abilities[a]?.proficient ?? 0;
    }

    // Skills
    for ( const [s, skl] of Object.entries(context.system.skills ?? {}) ) {
      skl.ability = CONFIG.DND5E.abilityAbbreviations[skl.ability];
      skl.icon = this._getProficiencyIcon(skl.value);
      skl.hover = CONFIG.DND5E.proficiencyLevels[skl.value];
      skl.label = CONFIG.DND5E.skills[s]?.label;
      skl.baseValue = source.system.skills[s]?.value ?? 0;
    }

    // Update traits
    this._prepareTraits(context.system.traits);

    // Prepare owned items
    this._prepareItems(context);

    // Biography HTML enrichment
    context.biographyHTML = await TextEditor.enrichHTML(context.system.details.biography.value, {
      secrets: this.actor.isOwner,
      rollData: context.rollData,
      async: true,
      relativeTo: this.actor
    });

    return context;
  }

  /* -------------------------------------------- */

  /**
   * Prepare labels object for the context.
   * @param {object} systemData  System data for the Actor being prepared.
   * @returns {object}           Object containing various labels.
   * @protected
   */
  _getLabels(systemData) {
    const labels = this.actor.labels ?? {};

    // Currency Labels
    labels.currencies = Object.entries(CONFIG.DND5E.currencies).reduce((obj, [k, c]) => {
      obj[k] = c.label;
      return obj;
    }, {});

    // Proficiency
    labels.proficiency = game.settings.get("dnd5e", "proficiencyModifier") === "dice"
      ? `d${systemData.attributes.prof * 2}`
      : `+${systemData.attributes.prof}`;

    return labels;
  }

  /* -------------------------------------------- */

  /**
   * Prepare the display of movement speed data for the Actor.
   * @param {object} systemData               System data for the Actor being prepared.
   * @param {boolean} [largestPrimary=false]  Show the largest movement speed as "primary", otherwise show "walk".
   * @returns {{primary: string, special: string}}
   * @private
   */
  _getMovementSpeed(systemData, largestPrimary=false) {
    const movement = systemData.attributes.movement ?? {};

    // Prepare an array of available movement speeds
    let speeds = [
      [movement.burrow, `${game.i18n.localize("DND5E.MovementBurrow")} ${movement.burrow}`],
      [movement.climb, `${game.i18n.localize("DND5E.MovementClimb")} ${movement.climb}`],
      [movement.fly, `${game.i18n.localize("DND5E.MovementFly")} ${movement.fly}${movement.hover ? ` (${game.i18n.localize("DND5E.MovementHover")})` : ""}`],
      [movement.swim, `${game.i18n.localize("DND5E.MovementSwim")} ${movement.swim}`]
    ];
    if ( largestPrimary ) {
      speeds.push([movement.walk, `${game.i18n.localize("DND5E.MovementWalk")} ${movement.walk}`]);
    }

    // Filter and sort speeds on their values
    speeds = speeds.filter(s => !!s[0]).sort((a, b) => b[0] - a[0]);

    // Case 1: Largest as primary
    if ( largestPrimary ) {
      let primary = speeds.shift();
      return {
        primary: `${primary ? primary[1] : "0"} ${movement.units}`,
        special: speeds.map(s => s[1]).join(", ")
      };
    }

    // Case 2: Walk as primary
    else {
      return {
        primary: `${movement.walk || 0} ${movement.units}`,
        special: speeds.length ? speeds.map(s => s[1]).join(", ") : ""
      };
    }
  }

  /* -------------------------------------------- */

  /**
   * Prepare senses object for display.
   * @param {object} systemData  System data for the Actor being prepared.
   * @returns {object}           Senses grouped by key with localized and formatted string.
   * @protected
   */
  _getSenses(systemData) {
    const senses = systemData.attributes.senses ?? {};
    const tags = {};
    for ( let [k, label] of Object.entries(CONFIG.DND5E.senses) ) {
      const v = senses[k] ?? 0;
      if ( v === 0 ) continue;
      tags[k] = `${game.i18n.localize(label)} ${v} ${senses.units}`;
    }
    if ( senses.special ) tags.special = senses.special;
    return tags;
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async activateEditor(name, options={}, initialContent="") {
    options.relativeLinks = true;
    return super.activateEditor(name, options, initialContent);
  }

  /* --------------------------------------------- */
  /*  Property Attribution                         */
  /* --------------------------------------------- */

  /**
   * Break down all of the Active Effects affecting a given target property.
   * @param {string} target               The data property being targeted.
   * @returns {AttributionDescription[]}  Any active effects that modify that property.
   * @protected
   */
  _prepareActiveEffectAttributions(target) {
    return this.actor.effects.reduce((arr, e) => {
      let source = e.sourceName;
      if ( e.origin === this.actor.uuid ) source = e.label;
      if ( !source || e.disabled || e.isSuppressed ) return arr;
      const value = e.changes.reduce((n, change) => {
        if ( (change.key !== target) || !Number.isNumeric(change.value) ) return n;
        if ( change.mode !== CONST.ACTIVE_EFFECT_MODES.ADD ) return n;
        return n + Number(change.value);
      }, 0);
      if ( !value ) return arr;
      arr.push({value, label: source, mode: CONST.ACTIVE_EFFECT_MODES.ADD});
      return arr;
    }, []);
  }

  /* -------------------------------------------- */

  /**
   * Produce a list of armor class attribution objects.
   * @param {object} rollData             Data provided by Actor5e#getRollData
   * @returns {AttributionDescription[]}  List of attribution descriptions.
   * @protected
   */
  _prepareArmorClassAttribution(rollData) {
    const ac = rollData.attributes.ac;
    const cfg = CONFIG.DND5E.armorClasses[ac.calc];
    const attribution = [];

    // Base AC Attribution
    switch ( ac.calc ) {

      // Flat AC
      case "flat":
        return [{
          label: game.i18n.localize("DND5E.ArmorClassFlat"),
          mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
          value: ac.flat
        }];

      // Natural armor
      case "natural":
        attribution.push({
          label: game.i18n.localize("DND5E.ArmorClassNatural"),
          mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
          value: ac.flat
        });
        break;

      default:
        const formula = ac.calc === "custom" ? ac.formula : cfg.formula;
        let base = ac.base;
        const dataRgx = new RegExp(/@([a-z.0-9_-]+)/gi);
        for ( const [match, term] of formula.matchAll(dataRgx) ) {
          const value = String(foundry.utils.getProperty(rollData, term));
          if ( (term === "attributes.ac.armor") || (value === "0") ) continue;
          if ( Number.isNumeric(value) ) base -= Number(value);
          attribution.push({
            label: match,
            mode: CONST.ACTIVE_EFFECT_MODES.ADD,
            value
          });
        }
        const armorInFormula = formula.includes("@attributes.ac.armor");
        let label = game.i18n.localize("DND5E.PropertyBase");
        if ( armorInFormula ) label = this.actor.armor?.name ?? game.i18n.localize("DND5E.ArmorClassUnarmored");
        attribution.unshift({
          label,
          mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
          value: base
        });
        break;
    }

    // Shield
    if ( ac.shield !== 0 ) attribution.push({
      label: this.actor.shield?.name ?? game.i18n.localize("DND5E.EquipmentShield"),
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: ac.shield
    });

    // Bonus
    if ( ac.bonus !== 0 ) attribution.push(...this._prepareActiveEffectAttributions("system.attributes.ac.bonus"));

    // Cover
    if ( ac.cover !== 0 ) attribution.push({
      label: game.i18n.localize("DND5E.Cover"),
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: ac.cover
    });
    return attribution;
  }

  /* -------------------------------------------- */

  /**
   * Prepare the data structure for traits data like languages, resistances & vulnerabilities, and proficiencies.
   * @param {object} traits   The raw traits data object from the actor data. *Will be mutated.*
   * @private
   */
  _prepareTraits(traits) {
    const map = {
      dr: CONFIG.DND5E.damageResistanceTypes,
      di: CONFIG.DND5E.damageResistanceTypes,
      dv: CONFIG.DND5E.damageResistanceTypes,
      ci: CONFIG.DND5E.conditionTypes,
      languages: CONFIG.DND5E.languages
    };
    for ( let [t, choices] of Object.entries(map) ) {
      const trait = traits[t];
      if ( !trait ) continue;
      let values = [];
      if ( trait.value ) values = trait.value instanceof Array ? trait.value : [trait.value];
      trait.selected = values.reduce((obj, t) => {
        obj[t] = choices[t];
        return obj;
      }, {});

      // Add custom entry
      if ( trait.custom ) trait.custom.split(";").forEach((c, i) => trait.selected[`custom${i+1}`] = c.trim());
      trait.cssClass = !foundry.utils.isEmpty(trait.selected) ? "" : "inactive";
    }

    // Populate and localize proficiencies
    for ( const t of ["armor", "weapon", "tool"] ) {
      const trait = traits[`${t}Prof`];
      if ( !trait ) continue;
      Actor5e.prepareProficiencies(trait, t);
      trait.cssClass = !foundry.utils.isEmpty(trait.selected) ? "" : "inactive";
    }
  }

  /* -------------------------------------------- */

  /**
   * Prepare the data structure for items which appear on the actor sheet.
   * Each subclass overrides this method to implement type-specific logic.
   * @protected
   */
  _prepareItems() {}

  /* -------------------------------------------- */

  /**
   * Insert a spell into the spellbook object when rendering the character sheet.
   * @param {object} context    Sheet rendering context data being prepared for render.
   * @param {object[]} spells   Spells to be included in the spellbook.
   * @returns {object[]}        Spellbook sections in the proper order.
   * @protected
   */
  _prepareSpellbook(context, spells) {
    const owner = this.actor.isOwner;
    const levels = context.actor.system.spells;
    const spellbook = {};

    // Define section and label mappings
    const sections = {atwill: -20, innate: -10, pact: 0.5 };
    const useLabels = {"-20": "-", "-10": "-", 0: "&infin;"};

    // Format a spellbook entry for a certain indexed level
    const registerSection = (sl, i, label, {prepMode="prepared", value, max, override}={}) => {
      spellbook[i] = {
        order: i,
        label: label,
        usesSlots: i > 0,
        canCreate: owner,
        canPrepare: (context.actor.type === "character") && (i >= 1),
        spells: [],
        uses: useLabels[i] || value || 0,
        slots: useLabels[i] || max || 0,
        override: override || 0,
        dataset: {type: "spell", level: prepMode in sections ? 1 : i, "preparation.mode": prepMode},
        prop: sl
      };
    };

    // Determine the maximum spell level which has a slot
    const maxLevel = Array.fromRange(10).reduce((max, i) => {
      if ( i === 0 ) return max;
      const level = levels[`spell${i}`];
      if ( (level.max || level.override ) && ( i > max ) ) max = i;
      return max;
    }, 0);

    // Level-based spellcasters have cantrips and leveled slots
    if ( maxLevel > 0 ) {
      registerSection("spell0", 0, CONFIG.DND5E.spellLevels[0]);
      for (let lvl = 1; lvl <= maxLevel; lvl++) {
        const sl = `spell${lvl}`;
        registerSection(sl, lvl, CONFIG.DND5E.spellLevels[lvl], levels[sl]);
      }
    }

    // Pact magic users have cantrips and a pact magic section
    if ( levels.pact && levels.pact.max ) {
      if ( !spellbook["0"] ) registerSection("spell0", 0, CONFIG.DND5E.spellLevels[0]);
      const l = levels.pact;
      const config = CONFIG.DND5E.spellPreparationModes.pact;
      const level = game.i18n.localize(`DND5E.SpellLevel${levels.pact.level}`);
      const label = `${config} — ${level}`;
      registerSection("pact", sections.pact, label, {
        prepMode: "pact",
        value: l.value,
        max: l.max,
        override: l.override
      });
    }

    // Iterate over every spell item, adding spells to the spellbook by section
    spells.forEach(spell => {
      const mode = spell.system.preparation.mode || "prepared";
      let s = spell.system.level || 0;
      const sl = `spell${s}`;

      // Specialized spellcasting modes (if they exist)
      if ( mode in sections ) {
        s = sections[mode];
        if ( !spellbook[s] ) {
          const l = levels[mode] || {};
          const config = CONFIG.DND5E.spellPreparationModes[mode];
          registerSection(mode, s, config, {
            prepMode: mode,
            value: l.value,
            max: l.max,
            override: l.override
          });
        }
      }

      // Sections for higher-level spells which the caster "should not" have, but spell items exist for
      else if ( !spellbook[s] ) {
        registerSection(sl, s, CONFIG.DND5E.spellLevels[s], {levels: levels[sl]});
      }

      // Add the spell to the relevant heading
      spellbook[s].spells.push(spell);
    });

    // Sort the spellbook by section level
    const sorted = Object.values(spellbook);
    sorted.sort((a, b) => a.order - b.order);
    return sorted;
  }

  /* -------------------------------------------- */

  /**
   * Determine whether an Owned Item will be shown based on the current set of filters.
   * @param {object[]} items       Copies of item data to be filtered.
   * @param {Set<string>} filters  Filters applied to the item list.
   * @returns {object[]}           Subset of input items limited by the provided filters.
   * @protected
   */
  _filterItems(items, filters) {
    return items.filter(item => {

      // Action usage
      for ( let f of ["action", "bonus", "reaction"] ) {
        if ( filters.has(f) && (item.system.activation?.type !== f) ) return false;
      }

      // Spell-specific filters
      if ( filters.has("ritual") && (item.system.components.ritual !== true) ) return false;
      if ( filters.has("concentration") && (item.system.components.concentration !== true) ) return false;
      if ( filters.has("prepared") ) {
        if ( (item.system.level === 0) || ["innate", "always"].includes(item.system.preparation.mode) ) return true;
        if ( this.actor.type === "npc" ) return true;
        return item.system.preparation.prepared;
      }

      // Equipment-specific filters
      if ( filters.has("equipped") && (item.system.equipped !== true) ) return false;
      return true;
    });
  }

  /* -------------------------------------------- */

  /**
   * Get the font-awesome icon used to display a certain level of skill proficiency.
   * @param {number} level  A proficiency mode defined in `CONFIG.DND5E.proficiencyLevels`.
   * @returns {string}      HTML string for the chosen icon.
   * @private
   */
  _getProficiencyIcon(level) {
    const icons = {
      0: '<i class="far fa-circle"></i>',
      0.5: '<i class="fas fa-adjust"></i>',
      1: '<i class="fas fa-check"></i>',
      2: '<i class="fas fa-check-double"></i>'
    };
    return icons[level] || icons[0];
  }

  /* -------------------------------------------- */
  /*  Event Listeners and Handlers                */
  /* -------------------------------------------- */

  /** @inheritdoc */
  activateListeners(html) {

    // Activate Item Filters
    const filterLists = html.find(".filter-list");
    filterLists.each(this._initializeFilterItemList.bind(this));
    filterLists.on("click", ".filter-item", this._onToggleFilter.bind(this));

    // Item summaries
    html.find(".item .item-name.rollable h4").click(event => this._onItemSummary(event));

    // View Item Sheets
    html.find(".item-edit").click(this._onItemEdit.bind(this));

    // Property attributions
    html.find(".attributable").mouseover(this._onPropertyAttribution.bind(this));

    // Editable Only Listeners
    if ( this.isEditable ) {

      // Input focus and update
      const inputs = html.find("input");
      inputs.focus(ev => ev.currentTarget.select());
      inputs.addBack().find('[type="number"]').change(this._onChangeInputDelta.bind(this));

      // Ability Proficiency
      html.find(".ability-proficiency").click(this._onToggleAbilityProficiency.bind(this));

      // Toggle Skill Proficiency
      html.find(".skill-proficiency").on("click contextmenu", this._onCycleSkillProficiency.bind(this));

      // Trait Selector
      html.find(".proficiency-selector").click(this._onProficiencySelector.bind(this));
      html.find(".trait-selector").click(this._onTraitSelector.bind(this));

      // Configure Special Flags
      html.find(".config-button").click(this._onConfigMenu.bind(this));

      // Owned Item management
      html.find(".item-create").click(this._onItemCreate.bind(this));
      html.find(".item-delete").click(this._onItemDelete.bind(this));
      html.find(".item-uses input").click(ev => ev.target.select()).change(this._onUsesChange.bind(this));
      html.find(".slot-max-override").click(this._onSpellSlotOverride.bind(this));

      // Active Effect management
      html.find(".effect-control").click(ev => ActiveEffect5e.onManageActiveEffect(ev, this.actor));
    }

    // Owner Only Listeners
    if ( this.actor.isOwner ) {

      // Ability Checks
      html.find(".ability-name").click(this._onRollAbilityTest.bind(this));

      // Roll Skill Checks
      html.find(".skill-name").click(this._onRollSkillCheck.bind(this));

      // Item Rolling
      html.find(".rollable .item-image").click(event => this._onItemUse(event));
      html.find(".item .item-recharge").click(event => this._onItemRecharge(event));
    }

    // Otherwise, remove rollable classes
    else {
      html.find(".rollable").each((i, el) => el.classList.remove("rollable"));
    }

    // Handle default listeners last so system listeners are triggered first
    super.activateListeners(html);
  }

  /* -------------------------------------------- */

  /**
   * Initialize Item list filters by activating the set of filters which are currently applied
   * @param {number} i  Index of the filter in the list.
   * @param {HTML} ul   HTML object for the list item surrounding the filter.
   * @private
   */
  _initializeFilterItemList(i, ul) {
    const set = this._filters[ul.dataset.filter];
    const filters = ul.querySelectorAll(".filter-item");
    for ( let li of filters ) {
      if ( set.has(li.dataset.filter) ) li.classList.add("active");
    }
  }

  /* -------------------------------------------- */
  /*  Event Listeners and Handlers                */
  /* -------------------------------------------- */

  /**
   * Handle input changes to numeric form fields, allowing them to accept delta-typed inputs
   * @param {Event} event  Triggering event.
   * @private
   */
  _onChangeInputDelta(event) {
    const input = event.target;
    const value = input.value;
    if ( ["+", "-"].includes(value[0]) ) {
      let delta = parseFloat(value);
      input.value = foundry.utils.getProperty(this.actor, input.name) + delta;
    }
    else if ( value[0] === "=" ) input.value = value.slice(1);
  }

  /* -------------------------------------------- */

  /**
   * Handle spawning the TraitSelector application which allows a checkbox of multiple trait options.
   * @param {Event} event   The click event which originated the selection.
   * @private
   */
  _onConfigMenu(event) {
    event.preventDefault();
    const button = event.currentTarget;
    let app;
    switch ( button.dataset.action ) {
      case "armor":
        app = new ActorArmorConfig(this.actor);
        break;
      case "hit-dice":
        app = new ActorHitDiceConfig(this.actor);
        break;
      case "movement":
        app = new ActorMovementConfig(this.actor);
        break;
      case "flags":
        app = new ActorSheetFlags(this.actor);
        break;
      case "senses":
        app = new ActorSensesConfig(this.actor);
        break;
      case "type":
        app = new ActorTypeConfig(this.actor);
        break;
      case "ability": {
        const ability = event.currentTarget.closest("[data-ability]").dataset.ability;
        app = new ActorAbilityConfig(this.actor, null, ability);
        break;
      }
      case "skill": {
        const skill = event.currentTarget.closest("[data-skill]").dataset.skill;
        app = new ActorSkillConfig(this.actor, null, skill);
        break;
      }
    }
    app?.render(true);
  }

  /* -------------------------------------------- */

  /**
   * Handle cycling proficiency in a Skill.
   * @param {Event} event   A click or contextmenu event which triggered the handler.
   * @returns {Promise}     Updated data for this actor after changes are applied.
   * @private
   */
  _onCycleSkillProficiency(event) {
    event.preventDefault();
    const field = event.currentTarget.previousElementSibling;
    const skillName = field.parentElement.dataset.skill;
    const source = this.actor._source.system.skills[skillName];
    if ( !source ) return;

    // Cycle to the next or previous skill level
    const levels = [0, 1, 0.5, 2];
    let idx = levels.indexOf(source.value);
    const next = idx + (event.type === "click" ? 1 : 3);
    field.value = levels[next % 4];

    // Update the field value and save the form
    return this._onSubmit(event);
  }

  /* -------------------------------------------- */

  /** @override */
  async _onDropActor(event, data) {
    const canPolymorph = game.user.isGM || (this.actor.isOwner && game.settings.get("dnd5e", "allowPolymorphing"));
    if ( !canPolymorph ) return false;

    // Get the target actor
    const cls = getDocumentClass("Actor");
    const sourceActor = await cls.fromDropData(data);
    if ( !sourceActor ) return;

    // Define a function to record polymorph settings for future use
    const rememberOptions = html => {
      const options = {};
      html.find("input").each((i, el) => {
        options[el.name] = el.checked;
      });
      const settings = foundry.utils.mergeObject(game.settings.get("dnd5e", "polymorphSettings") ?? {}, options);
      game.settings.set("dnd5e", "polymorphSettings", settings);
      return settings;
    };

    // Create and render the Dialog
    return new Dialog({
      title: game.i18n.localize("DND5E.PolymorphPromptTitle"),
      content: {
        options: game.settings.get("dnd5e", "polymorphSettings"),
        i18n: CONFIG.DND5E.polymorphSettings,
        isToken: this.actor.isToken
      },
      default: "accept",
      buttons: {
        accept: {
          icon: '<i class="fas fa-check"></i>',
          label: game.i18n.localize("DND5E.PolymorphAcceptSettings"),
          callback: html => this.actor.transformInto(sourceActor, rememberOptions(html))
        },
        wildshape: {
          icon: '<i class="fas fa-paw"></i>',
          label: game.i18n.localize("DND5E.PolymorphWildShape"),
          callback: html => this.actor.transformInto(sourceActor, {
            keepBio: true,
            keepClass: true,
            keepMental: true,
            mergeSaves: true,
            mergeSkills: true,
            transformTokens: rememberOptions(html).transformTokens
          })
        },
        polymorph: {
          icon: '<i class="fas fa-pastafarianism"></i>',
          label: game.i18n.localize("DND5E.Polymorph"),
          callback: html => this.actor.transformInto(sourceActor, {
            transformTokens: rememberOptions(html).transformTokens
          })
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize("Cancel")
        }
      }
    }, {
      classes: ["dialog", "dnd5e"],
      width: 600,
      template: "systems/dnd5e/templates/apps/polymorph-prompt.hbs"
    }).render(true);
  }

  /* -------------------------------------------- */

  /** @override */
  async _onDropItemCreate(itemData) {
    let items = itemData instanceof Array ? itemData : [itemData];
    const itemsWithoutAdvancement = items.filter(i => !i.system.advancement?.length);
    const multipleAdvancements = (items.length - itemsWithoutAdvancement.length) > 1;
    if ( multipleAdvancements && !game.settings.get("dnd5e", "disableAdvancements") ) {
      ui.notifications.warn(game.i18n.format("DND5E.WarnCantAddMultipleAdvancements"));
      items = itemsWithoutAdvancement;
    }

    const toCreate = [];
    for ( const item of items ) {
      const result = await this._onDropSingleItem(item);
      if ( result ) toCreate.push(result);
    }

    // Create the owned items as normal
    return this.actor.createEmbeddedDocuments("Item", toCreate);
  }

  /* -------------------------------------------- */

  /**
   * Handles dropping of a single item onto this character sheet.
   * @param {object} itemData            The item data to create.
   * @returns {Promise<object|boolean>}  The item data to create after processing, or false if the item should not be
   *                                     created or creation has been otherwise handled.
   * @protected
   */
  async _onDropSingleItem(itemData) {

    // Check to make sure items of this type are allowed on this actor
    if ( this.constructor.unsupportedItemTypes.has(itemData.type) ) {
      ui.notifications.warn(game.i18n.format("DND5E.ActorWarningInvalidItem", {
        itemType: game.i18n.localize(CONFIG.Item.typeLabels[itemData.type]),
        actorType: game.i18n.localize(CONFIG.Actor.typeLabels[this.actor.type])
      }));
      return false;
    }

    // Create a Consumable spell scroll on the Inventory tab
    if ( (itemData.type === "spell") && (this._tabs[0].active === "inventory") ) {
      const scroll = await Item5e.createScrollFromSpell(itemData);
      return scroll.toObject();
    }

    // Clean up data
    this._onDropResetData(itemData);

    // Stack identical consumables
    const stacked = this._onDropStackConsumables(itemData);
    if ( stacked ) return false;

    // Bypass normal creation flow for any items with advancement
    if ( itemData.system.advancement?.length && !game.settings.get("dnd5e", "disableAdvancements") ) {
      const manager = AdvancementManager.forNewItem(this.actor, itemData);
      if ( manager.steps.length ) {
        manager.render(true);
        return false;
      }
    }
    return itemData;
  }

  /* -------------------------------------------- */

  /**
   * Reset certain pieces of data stored on items when they are dropped onto the actor.
   * @param {object} itemData    The item data requested for creation. **Will be mutated.**
   */
  _onDropResetData(itemData) {
    if ( !itemData.system ) return;
    ["equipped", "proficient", "prepared"].forEach(k => delete itemData.system[k]);
    if ( "attunement" in itemData.system ) {
      itemData.system.attunement = Math.min(itemData.system.attunement, CONFIG.DND5E.attunementTypes.REQUIRED);
    }
  }

  /* -------------------------------------------- */

  /**
   * Stack identical consumables when a new one is dropped rather than creating a duplicate item.
   * @param {object} itemData         The item data requested for creation.
   * @returns {Promise<Item5e>|null}  If a duplicate was found, returns the adjusted item stack.
   */
  _onDropStackConsumables(itemData) {
    const droppedSourceId = itemData.flags.core?.sourceId;
    if ( itemData.type !== "consumable" || !droppedSourceId ) return null;
    const similarItem = this.actor.items.find(i => {
      const sourceId = i.getFlag("core", "sourceId");
      return sourceId && (sourceId === droppedSourceId) && (i.type === "consumable") && (i.name === itemData.name);
    });
    if ( !similarItem ) return null;
    return similarItem.update({
      "system.quantity": similarItem.system.quantity + Math.max(itemData.system.quantity, 1)
    });
  }

  /* -------------------------------------------- */

  /**
   * Handle enabling editing for a spell slot override value.
   * @param {MouseEvent} event    The originating click event.
   * @private
   */
  async _onSpellSlotOverride(event) {
    const span = event.currentTarget.parentElement;
    const level = span.dataset.level;
    const override = this.actor.system.spells[level].override || span.dataset.slots;
    const input = document.createElement("INPUT");
    input.type = "text";
    input.name = `system.spells.${level}.override`;
    input.value = override;
    input.placeholder = span.dataset.slots;
    input.dataset.dtype = "Number";

    // Replace the HTML
    const parent = span.parentElement;
    parent.removeChild(span);
    parent.appendChild(input);
  }

  /* -------------------------------------------- */

  /**
   * Change the uses amount of an Owned Item within the Actor.
   * @param {Event} event        The triggering click event.
   * @returns {Promise<Item5e>}  Updated item.
   * @private
   */
  async _onUsesChange(event) {
    event.preventDefault();
    const itemId = event.currentTarget.closest(".item").dataset.itemId;
    const item = this.actor.items.get(itemId);
    const uses = Math.clamped(0, parseInt(event.target.value), item.system.uses.max);
    event.target.value = uses;
    return item.update({"system.uses.value": uses});
  }

  /* -------------------------------------------- */

  /**
   * Handle using an item from the Actor sheet, obtaining the Item instance, and dispatching to its use method.
   * @param {Event} event  The triggering click event.
   * @returns {Promise}    Results of the usage.
   * @protected
   */
  _onItemUse(event) {
    event.preventDefault();
    const itemId = event.currentTarget.closest(".item").dataset.itemId;
    const item = this.actor.items.get(itemId);
    if ( item ) return item.use();
  }

  /* -------------------------------------------- */

  /**
   * Handle attempting to recharge an item usage by rolling a recharge check.
   * @param {Event} event      The originating click event.
   * @returns {Promise<Roll>}  The resulting recharge roll.
   * @private
   */
  _onItemRecharge(event) {
    event.preventDefault();
    const itemId = event.currentTarget.closest(".item").dataset.itemId;
    const item = this.actor.items.get(itemId);
    return item.rollRecharge();
  }

  /* -------------------------------------------- */

  /**
   * Handle toggling and items expanded description.
   * @param {Event} event   Triggering event.
   * @private
   */
  async _onItemSummary(event) {
    event.preventDefault();
    const li = $(event.currentTarget).parents(".item");
    const item = this.actor.items.get(li.data("item-id"));
    const chatData = await item.getChatData({secrets: this.actor.isOwner});

    // Toggle summary
    if ( li.hasClass("expanded") ) {
      let summary = li.children(".item-summary");
      summary.slideUp(200, () => summary.remove());
    } else {
      let div = $(`<div class="item-summary">${chatData.description.value}</div>`);
      let props = $('<div class="item-properties"></div>');
      chatData.properties.forEach(p => props.append(`<span class="tag">${p}</span>`));
      div.append(props);
      li.append(div.hide());
      div.slideDown(200);
    }
    li.toggleClass("expanded");
  }

  /* -------------------------------------------- */

  /**
   * Handle creating a new Owned Item for the actor using initial data defined in the HTML dataset.
   * @param {Event} event          The originating click event.
   * @returns {Promise<Item5e[]>}  The newly created item.
   * @private
   */
  _onItemCreate(event) {
    event.preventDefault();
    const header = event.currentTarget;
    const type = header.dataset.type;

    // Check to make sure the newly created class doesn't take player over level cap
    if ( type === "class" && (this.actor.system.details.level + 1 > CONFIG.DND5E.maxLevel) ) {
      const err = game.i18n.format("DND5E.MaxCharacterLevelExceededWarn", {max: CONFIG.DND5E.maxLevel});
      return ui.notifications.error(err);
    }

    const itemData = {
      name: game.i18n.format("DND5E.ItemNew", {type: game.i18n.localize(`DND5E.ItemType${type.capitalize()}`)}),
      type: type,
      system: foundry.utils.deepClone(header.dataset)
    };
    delete itemData.system.type;
    return this.actor.createEmbeddedDocuments("Item", [itemData]);
  }

  /* -------------------------------------------- */

  /**
   * Handle editing an existing Owned Item for the Actor.
   * @param {Event} event    The originating click event.
   * @returns {ItemSheet5e}  The rendered item sheet.
   * @private
   */
  _onItemEdit(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    return item.sheet.render(true);
  }

  /* -------------------------------------------- */

  /**
   * Handle deleting an existing Owned Item for the Actor.
   * @param {Event} event  The originating click event.
   * @returns {Promise<Item5e|AdvancementManager>|undefined}  The deleted item if something was deleted or the
   *                                                          advancement manager if advancements need removing.
   * @private
   */
  async _onItemDelete(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if ( !item ) return;

    // If item has advancement, handle it separately
    if ( !game.settings.get("dnd5e", "disableAdvancements") ) {
      const manager = AdvancementManager.forDeletedItem(this.actor, item.id);
      if ( manager.steps.length ) {
        if ( ["class", "subclass"].includes(item.type) ) {
          try {
            const shouldRemoveAdvancements = await AdvancementConfirmationDialog.forDelete(item);
            if ( shouldRemoveAdvancements ) return manager.render(true);
          } catch(err) {
            return;
          }
        } else {
          return manager.render(true);
        }
      }
    }

    return item.delete();
  }

  /* -------------------------------------------- */

  /**
   * Handle displaying the property attribution tooltip when a property is hovered over.
   * @param {Event} event   The originating mouse event.
   * @private
   */
  async _onPropertyAttribution(event) {
    const existingTooltip = event.currentTarget.querySelector("div.tooltip");
    const property = event.currentTarget.dataset.property;
    if ( existingTooltip || !property ) return;
    const rollData = this.actor.getRollData({ deterministic: true });
    let attributions;
    switch ( property ) {
      case "attributes.ac":
        attributions = this._prepareArmorClassAttribution(rollData); break;
    }
    if ( !attributions ) return;
    const html = await new PropertyAttribution(this.actor, attributions, property).renderTooltip();
    event.currentTarget.insertAdjacentElement("beforeend", html[0]);
  }

  /* -------------------------------------------- */

  /**
   * Handle rolling an Ability test or saving throw.
   * @param {Event} event      The originating click event.
   * @private
   */
  _onRollAbilityTest(event) {
    event.preventDefault();
    let ability = event.currentTarget.parentElement.dataset.ability;
    this.actor.rollAbility(ability, {event: event});
  }

  /* -------------------------------------------- */

  /**
   * Handle rolling a Skill check.
   * @param {Event} event      The originating click event.
   * @returns {Promise<Roll>}  The resulting roll.
   * @private
   */
  _onRollSkillCheck(event) {
    event.preventDefault();
    const skill = event.currentTarget.closest("[data-skill]").dataset.skill;
    return this.actor.rollSkill(skill, {event: event});
  }

  /* -------------------------------------------- */

  /**
   * Handle toggling Ability score proficiency level.
   * @param {Event} event         The originating click event.
   * @returns {Promise<Actor5e>}  Updated actor instance.
   * @private
   */
  _onToggleAbilityProficiency(event) {
    event.preventDefault();
    const field = event.currentTarget.previousElementSibling;
    return this.actor.update({[field.name]: 1 - parseInt(field.value)});
  }

  /* -------------------------------------------- */

  /**
   * Handle toggling of filters to display a different set of owned items.
   * @param {Event} event     The click event which triggered the toggle.
   * @returns {ActorSheet5e}  This actor sheet with toggled filters.
   * @private
   */
  _onToggleFilter(event) {
    event.preventDefault();
    const li = event.currentTarget;
    const set = this._filters[li.parentElement.dataset.filter];
    const filter = li.dataset.filter;
    if ( set.has(filter) ) set.delete(filter);
    else set.add(filter);
    return this.render();
  }

  /* -------------------------------------------- */

  /**
   * Handle spawning the ProficiencySelector application to configure armor, weapon, and tool proficiencies.
   * @param {Event} event            The click event which originated the selection.
   * @returns {ProficiencySelector}  Newly displayed application.
   * @private
   */
  _onProficiencySelector(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const label = a.parentElement.querySelector("label");
    const options = { name: a.dataset.target, title: `${label.innerText}: ${this.actor.name}`, type: a.dataset.type };
    return new ProficiencySelector(this.actor, options).render(true);
  }

  /* -------------------------------------------- */

  /**
   * Handle spawning the TraitSelector application which allows a checkbox of multiple trait options.
   * @param {Event} event      The click event which originated the selection.
   * @returns {TraitSelector}  Newly displayed application.
   * @private
   */
  _onTraitSelector(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const label = a.parentElement.querySelector("label");
    const choices = CONFIG.DND5E[a.dataset.options];
    const options = { name: a.dataset.target, title: `${label.innerText}: ${this.actor.name}`, choices };
    return new TraitSelector(this.actor, options).render(true);
  }

  /* -------------------------------------------- */

  /** @override */
  _getHeaderButtons() {
    let buttons = super._getHeaderButtons();
    if ( this.actor.isPolymorphed ) {
      buttons.unshift({
        label: "DND5E.PolymorphRestoreTransformation",
        class: "restore-transformation",
        icon: "fas fa-backward",
        onclick: () => this.actor.revertOriginalForm()
      });
    }
    return buttons;
  }
}
