import { MODULE_ID } from '../constants.js';
import * as Data from '../data.js';
import { ReputationEvents } from '../events.js';
import * as Core from '../core/index.js';
import { getMode, setMode } from '../core/reputation.js';
import { PickerApp } from './PickerApp.js';
import { LOCATION_TYPES, FACTION_TYPES, buildActorData, buildFactionData, buildLocationData, buildDetail, canEditActor } from './relations/RelationsBuilders.js';
import { loadState, saveState, resolveOwnerActor, ensureTreeExpanded, restoreNavGroups, restoreSections, restoreScroll, restoreNavWidth } from './relations/RelationsState.js';
import { attachInputListeners, attachBarListeners, attachNavSearchListener, attachResizeHandle, attachImagePopout, attachRankDragDrop, updateBarVisual, fitTierBadges } from './relations/RelationsListeners.js';
import { attachDropListeners, attachNestingDragDrop, attachNavItemDrag, attachDetailSectionDrop, attachNavTreeSidebarDrop } from './relations/RelationsDragDrop.js';
import { attachContextMenu } from './relations/RelationsContext.js';

export class RelationsViewerApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/relations/main.hbs` }
  };

  constructor(options = {}) {
    super(options);
    loadState(this);
    this.scrollPos = 0;
    this._unsubscribers = [];
    this._busy = false;
    this._editingDescriptions = new Set();
    this.ownerActorId = resolveOwnerActor();
    if (!this.selectedType && this.ownerActorId) {
      this.selectedType = 'actor';
      this.selectedId = this.ownerActorId;
    }
  }

  get title() {
    return game.i18n.localize(`${MODULE_ID}.relations.viewer-title`);
  }

  _saveState() { saveState(this); }
  _ensureTreeExpanded(type, id) { ensureTreeExpanded(this, type, id); }
  _updateBarVisual(container, value) { updateBarVisual(container, value); }

  _onFirstRender() {
    this._subscribeToEvents();
    if (game.user.isGM) Core.ensureActiveParty();
  }

  _subscribeToEvents() {
    this._unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
    this._unsubscribers = [];

    const scheduleRender = foundry.utils.debounce(() => {
      if (this._busy || !this.rendered) return;
      this.render();
    }, 250);
    this._unsubscribers = Object.values(ReputationEvents.EVENTS).map(event =>
      ReputationEvents.on(event, scheduleRender)
    );
  }

  async close(options = {}) {
    this._saveState();
    this._unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
    this._unsubscribers = [];
    return super.close(options);
  }

  async _prepareContext(options) {
    const { min, max } = Data.getLimits();
    const isGM = game.user.isGM;
    const pcs = Core.getPCs();
    const rawFactions = Core.getFactions();

    let allActorsFlat = (await Promise.all(
      Core.getTracked().map(id => buildActorData(id, min, max, pcs, rawFactions))
    )).filter(Boolean);

    let allFactionsFlat = await Promise.all(
      rawFactions.map(f => buildFactionData(f, pcs, min, max, isGM))
    );

    let allLocationsFlat = await Promise.all(
      Core.getLocations().map(l => buildLocationData(l, allFactionsFlat, allActorsFlat, isGM))
    );

    if (!isGM) {
      allActorsFlat = allActorsFlat.filter(a => !a.hidden).map(a => ({
        ...a,
        relations: a.relations.filter(r => !r.hidden),
        playerRelations: a.playerRelations.filter(r => !r.hidden),
        npcRelations: a.npcRelations.filter(r => !r.hidden),
        factionRelations: a.factionRelations.filter(r => !r.hidden && !r.factionHidden)
      }));
      allFactionsFlat = allFactionsFlat.filter(f => !f.hidden).map(f => ({
        ...f,
        members: f.members.filter(m => !m.hidden && !m.actorHidden),
        factionRels: f.factionRels.filter(r => !r.hidden),
        factionPcRels: f.factionPcRels.filter(r => !r.hidden),
        factionNpcRels: f.factionNpcRels.filter(r => !r.hidden),
        factionToFactionRels: f.factionToFactionRels.filter(r => !r.hidden && !r.targetHidden)
      }));
      allLocationsFlat = allLocationsFlat.filter(l => !l.hidden).map(l => ({
        ...l,
        factionsList: l.factionsList.filter(f => !f.locItemHidden && !f.hidden),
        actorsList: l.actorsList.filter(a => !a.locItemHidden && !a.hidden)
      }));
    }

    allLocationsFlat.sort((a, b) => a.name.localeCompare(b.name));
    allFactionsFlat.sort((a, b) => a.name.localeCompare(b.name));

    let allLocations = Core.buildTree(allLocationsFlat, this.treeExpandedLocations);
    let allFactions = Core.buildTree(allFactionsFlat, this.treeExpandedFactions);

    if (this.navSearch) {
      const q = this.navSearch.toLowerCase();
      allLocations = allLocations.filter(l => l.name.toLowerCase().includes(q));
      allFactions = allFactions.filter(f => f.name.toLowerCase().includes(q));
      allActorsFlat = allActorsFlat.filter(a => a.name.toLowerCase().includes(q));
    }

    const activeParty = Core.getActiveParty();
    const activePartyMembers = activeParty ? new Set(activeParty.members || []) : null;
    const { pcs: playerActorsRaw, npcs: npcActors } = Core.separatePlayerAndNPC(allActorsFlat);

    let playerActors;
    if (activePartyMembers) {
      playerActors = allActorsFlat.filter(a => activePartyMembers.has(a.id));
    } else {
      playerActors = playerActorsRaw;
    }

    playerActors.sort((a, b) => a.name.localeCompare(b.name));
    npcActors.sort((a, b) => a.name.localeCompare(b.name));

    // Group the Characters (NPC) section by faction (when enabled). A character is
    // listed under every faction it is a direct member of; characters in no faction
    // fall into an Ungrouped bucket. Faction subheaders follow full faction-tree
    // order/indent and respect visibility (allFactionsFlat is already hidden-filtered
    // for non-GMs).
    //
    // Two client settings drive this:
    //   groupCharactersByFaction      — navigator on/off (client, UI toggle).
    //   groupDetailRelationsByFaction — actor detail pane on/off (world, GM setting).
    //   autoExpandGroups              — default open/closed state of each group; the
    //                                   *Collapsed sets store only the user's deviations
    //                                   from that default, so toggling works either way.
    //                                   Shared by both groupings.
    const groupByFaction = game.settings.get(MODULE_ID, "groupCharactersByFaction");
    const groupDetailByFaction = game.settings.get(MODULE_ID, "groupDetailRelationsByFaction");
    const autoExpand = game.settings.get(MODULE_ID, "autoExpandGroups");
    const isGroupCollapsed = (set, id) => (autoExpand ? set.has(id) : !set.has(id));

    const orderedFactions = Core.buildTree(allFactionsFlat, new Set(allFactionsFlat.map(f => f.id)));
    const npcGroups = [];
    let ungroupedNpcs = npcActors;
    // A collapsed faction hides its whole subtree, so a sub-group whose ancestor is
    // collapsed is not emitted as its own block. orderedFactions is parent-first, so
    // collapsedGroupIds is fully populated for any ancestor by the time we reach a child.
    const facById = new Map(allFactionsFlat.map(f => [f.id, f]));
    const hasCollapsedAncestor = (fac, collapsedSet) => {
      const seen = new Set();
      let cur = facById.get(fac.parentId);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (collapsedSet.has(cur.id)) return true;
        cur = facById.get(cur.parentId);
      }
      return false;
    };
    const isDescendantOf = (facId, ancestorId) => {
      const seen = new Set();
      let cur = facById.get(facId);
      while (cur?.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        if (cur.parentId === ancestorId) return true;
        cur = facById.get(cur.parentId);
      }
      return false;
    };
    // actorId → set of factions it is a *direct* member of. Used to suppress an actor
    // from an ancestor org when it is also a direct member of a descendant group.
    const directMemberFactions = new Map();
    for (const f of orderedFactions) {
      for (const m of (f.members || [])) {
        if (m.sourceFactionId !== f.id) continue;
        let s = directMemberFactions.get(m.id);
        if (!s) { s = new Set(); directMemberFactions.set(m.id, s); }
        s.add(f.id);
      }
    }
    const shownUnderDescendant = (actorId, facId) => {
      const facs = directMemberFactions.get(actorId);
      if (!facs) return false;
      for (const fid of facs) {
        if (fid !== facId && isDescendantOf(fid, facId)) return true;
      }
      return false;
    };
    // Given factions that have their own content, also mark every ancestor as needing
    // to render — so an org with no direct members still shows a header above its
    // populated sub-groups. Factions whose whole subtree is empty stay hidden.
    const factionsToRender = (contentFacIds) => {
      const render = new Set();
      for (const fid of contentFacIds) {
        render.add(fid);
        const seen = new Set();
        let cur = facById.get(fid);
        while (cur?.parentId && !seen.has(cur.parentId)) {
          seen.add(cur.parentId);
          render.add(cur.parentId);
          cur = facById.get(cur.parentId);
        }
      }
      return render;
    };

    if (groupByFaction) {
      const npcById = new Map(npcActors.map(a => [a.id, a]));
      const groupedNpcIds = new Set();
      const collapsedGroupIds = new Set();

      // Direct members per faction (deduped against descendant groups).
      const membersByFac = new Map();
      for (const fac of orderedFactions) {
        const members = (fac.members || [])
          .filter(m => m.sourceFactionId === fac.id) // direct members only (skip org roll-up)
          .filter(m => !shownUnderDescendant(m.id, fac.id)) // belongs to a child group → show there only
          .map(m => npcById.get(m.id))
          .filter(Boolean);
        if (members.length) membersByFac.set(fac.id, members);
      }
      const renderFac = factionsToRender(membersByFac.keys());

      for (const fac of orderedFactions) {
        if (!renderFac.has(fac.id)) continue; // empty subtree → hidden
        const members = membersByFac.get(fac.id) || []; // empty = org header above sub-groups
        members.forEach(m => groupedNpcIds.add(m.id)); // counted as grouped even if hidden by collapse
        const collapsed = isGroupCollapsed(this.npcGroupsCollapsed, fac.id);
        if (collapsed) collapsedGroupIds.add(fac.id);
        if (hasCollapsedAncestor(fac, collapsedGroupIds)) continue; // ancestor collapsed → hide block
        members.sort((a, b) => a.name.localeCompare(b.name));
        npcGroups.push({
          id: fac.id, name: fac.name, image: fac.image, hidden: fac.hidden,
          tier: fac.tier, isPartyActive: fac.isPartyActive,
          collapsed,
          level: fac.level, memberLevel: fac.level + 1,
          members
        });
      }
      ungroupedNpcs = npcActors.filter(a => !groupedNpcIds.has(a.id));
    }

    let detail = null;
    if (this.selectedType && this.selectedId) {
      detail = buildDetail(this, this.selectedType, this.selectedId, allLocations, allFactions, allActorsFlat);
      if (detail && (isGM || detail.canEdit)) {
        detail.isEditingDescription = this._editingDescriptions.has(`${this.selectedType}:${this.selectedId}`);
      }
      // Group the actor detail's "Relations to Characters" by faction, mirroring the
      // navigator Characters section. Reuses orderedFactions (full tree, unaffected by
      // nav collapse state) and the already hidden-filtered detail.npcRelations.
      // Driven by its own world setting, independent of the navigator's client toggle.
      if (detail && this.selectedType === 'actor') {
        const relGroups = [];
        const groupedRelIds = new Set();
        if (groupDetailByFaction) {
          const collapsedRelIds = new Set();
          const relsByFac = new Map();
          for (const fac of orderedFactions) {
            const memberIds = new Set(
              (fac.members || [])
                .filter(m => m.sourceFactionId === fac.id && !shownUnderDescendant(m.id, fac.id))
                .map(m => m.id)
            );
            const rels = detail.npcRelations.filter(r => memberIds.has(r.pcId));
            if (rels.length) relsByFac.set(fac.id, rels);
          }
          const renderRelFac = factionsToRender(relsByFac.keys());

          for (const fac of orderedFactions) {
            if (!renderRelFac.has(fac.id)) continue; // empty subtree → hidden
            const rels = relsByFac.get(fac.id) || []; // empty = org header above sub-groups
            rels.forEach(r => groupedRelIds.add(r.pcId));
            const collapsed = isGroupCollapsed(this.relGroupsCollapsed, fac.id);
            if (collapsed) collapsedRelIds.add(fac.id);
            if (hasCollapsedAncestor(fac, collapsedRelIds)) continue; // ancestor collapsed → hide block
            relGroups.push({
              id: fac.id, name: fac.name, image: fac.image, hidden: fac.hidden,
              tier: fac.tier, isPartyActive: fac.isPartyActive,
              level: fac.level, memberLevel: fac.level + 1,
              collapsed, rels
            });
          }
        }
        detail.npcRelationGroups = relGroups;
        detail.ungroupedNpcRelations = groupDetailByFaction
          ? detail.npcRelations.filter(r => !groupedRelIds.has(r.pcId))
          : detail.npcRelations;
      }
    }

    let ownerActor = null;
    if (this.ownerActorId) {
      const actor = game.actors.get(this.ownerActorId);
      if (actor) {
        ownerActor = {
          id: actor.id,
          name: Core.getDisplayName(actor.id),
          img: actor.img || 'icons/svg/mystery-man.svg',
          isTracked: Core.getTracked().includes(actor.id)
        };
      }
    }

    return {
      min, max, isGM, pcs, allLocations, allFactions, playerActors, npcActors, npcGroups, ungroupedNpcs, groupByFaction,
      selectedType: this.selectedType, selectedId: this.selectedId,
      detail, navSearch: this.navSearch, moduleId: MODULE_ID, ownerActor,
      activePartyId: Core.getActivePartyId(),
      activePartyName: activeParty?.name || null,
      locationTypes: LOCATION_TYPES.map(t => ({ ...t, name: game.i18n.localize(`${MODULE_ID}.types.location.${t.id}`) })),
      factionTypes: FACTION_TYPES.map(t => ({ ...t, name: game.i18n.localize(`${MODULE_ID}.types.faction.${t.id}`) }))
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const content = html.querySelector('.fame-relations-content');
    if (content) {
      content.classList.add('no-transitions');
      requestAnimationFrame(() => requestAnimationFrame(() => content.classList.remove('no-transitions')));
    }
    attachInputListeners(html, this);
    attachBarListeners(html, this);
    attachNavSearchListener(html, this);
    attachResizeHandle(html, this);
    attachContextMenu(html, this);
    attachImagePopout(html);
    if (game.user.isGM) {
      attachDropListeners(html);
      attachNestingDragDrop(html, this);
      attachRankDragDrop(html);
      attachNavItemDrag(html);
      attachDetailSectionDrop(html);
      attachNavTreeSidebarDrop(html, this);
    }
    restoreNavGroups(html, this);
    restoreSections(html, this);
    restoreScroll(html, this);
    restoreNavWidth(html, this);
    fitTierBadges(html);
    const panel = html.querySelector('.fame-detail-panel');
    if (panel) panel.addEventListener('scroll', () => { this.scrollPos = panel.scrollTop; }, { passive: true });
    const navTree = html.querySelector('.fame-nav-tree');
    if (navTree) navTree.addEventListener('scroll', () => { this.navScrollPos = navTree.scrollTop; }, { passive: true });
  }

  static #onSelectEntity(event, target) {
    event.stopPropagation();
    this.selectedType = target.dataset.entityType;
    this.selectedId = target.dataset.entityId;
    this.scrollPos = 0;
    this._ensureTreeExpanded(this.selectedType, this.selectedId);
    this._saveState();
    this.render();
  }

  static #onGoToOwner(event, target) {
    event.stopPropagation();
    if (!this.ownerActorId) return;
    const actor = game.actors.get(this.ownerActorId);
    if (actor) {
      const tracked = Core.getTracked();
      if (!tracked.includes(this.ownerActorId)) {
        if (!actor.hasPlayerOwner) Core.ensureImportant(actor);
        Core.addTracked(this.ownerActorId);
      }
    }
    this.selectedType = 'actor';
    this.selectedId = this.ownerActorId;
    this.scrollPos = 0;
    this._saveState();
    this.render();
  }

  static #onOpenActorSheet(event, target) {
    event.stopPropagation();
    const actor = game.actors.get(target.dataset.actorId);
    if (actor?.isOwner) actor.sheet.render(true);
  }

  static #onToggleNavGroup(event, target) {
    event.stopPropagation();
    const group = target.dataset.group;
    const el = target.closest('.fame-nav-group');
    if (!el) return;
    el.classList.toggle('open');
    if (el.classList.contains('open')) this.closedNavGroups.delete(group);
    else this.closedNavGroups.add(group);
    this._saveState();
  }

  static #onToggleTreeExpand(event, target) {
    event.stopPropagation();
    const { id, type } = target.dataset;
    const set = type === 'faction' ? this.treeExpandedFactions : this.treeExpandedLocations;
    set.has(id) ? set.delete(id) : set.add(id);
    this._saveState();
    this.render();
  }

  static #onToggleCharacterGrouping(event) {
    event.stopPropagation();
    const current = game.settings.get(MODULE_ID, "groupCharactersByFaction");
    game.settings.set(MODULE_ID, "groupCharactersByFaction", !current);
    this.render();
  }

  static #onToggleNpcGroup(event, target) {
    event.stopPropagation();
    const { id } = target.dataset;
    this.npcGroupsCollapsed.has(id) ? this.npcGroupsCollapsed.delete(id) : this.npcGroupsCollapsed.add(id);
    this._saveState();
    this.render();
  }

  static #onToggleRelGroup(event, target) {
    event.stopPropagation();
    const { id } = target.dataset;
    this.relGroupsCollapsed.has(id) ? this.relGroupsCollapsed.delete(id) : this.relGroupsCollapsed.add(id);
    this._saveState();
    this.render();
  }

  static #onToggleDetailSection(event, target) {
    event.stopPropagation();
    const section = target.dataset.section;
    const el = target.closest('.fame-detail-section');
    if (!el) return;
    el.classList.toggle('open');
    if (el.classList.contains('open')) this.openSections.add(section);
    else this.openSections.delete(section);
    this._saveState();
  }

  static async #onToggleHidden(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    target.classList.toggle('active');
    this.element?.querySelector(`.fame-nav-item[data-entity-id="${target.dataset.id}"]`)?.classList.toggle('is-hidden');
    await Core.toggleHidden(target.dataset.type, target.dataset.id);
  }

  static async #onToggleRelationHidden(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    target.classList.toggle('active');
    target.closest('.fame-detail-rel-row')?.classList.toggle('is-hidden');
    await Core.toggleRelationHidden(target.dataset.relType, target.dataset.entityId, target.dataset.targetId);
  }

  static async #onSetLocationControl(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const { PickerApp } = await import('./PickerApp.js');
    PickerApp.openFactionPicker({
      callback: async factionId => {
        const locations = Core.getLocations();
        const loc = locations.find(l => l.id === target.dataset.location);
        if (loc) {
          loc.controlledBy = factionId;
          await Core.setLocations(locations);
        }
      }
    });
  }

  static async #onClearLocationControl(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const locations = Core.getLocations();
    const loc = locations.find(l => l.id === target.dataset.location);
    if (loc) {
      delete loc.controlledBy;
      await Core.setLocations(locations);
    }
  }

  static async #onToggleMemberHidden(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    target.classList.toggle('active');
    target.closest('.fame-detail-member-row')?.classList.toggle('is-hidden');
    await Core.toggleMemberHidden(target.dataset.faction, target.dataset.actor);
  }

  static async #onToggleLocationItemHidden(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    target.classList.toggle('active');
    target.closest('.fame-detail-rel-row')?.classList.toggle('is-hidden');
    await Core.toggleLocationItemHidden(target.dataset.location, target.dataset.itemType, target.dataset.itemId);
  }

  static async #onCycleActorMode(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const modes = ['manual', 'auto', 'hybrid'];
    const current = getMode(target.dataset.id, 'actor');
    await setMode(target.dataset.id, 'actor', modes[(modes.indexOf(current) + 1) % 3]);
  }

  static async #onCycleFactionMode(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const modes = ['manual', 'auto', 'hybrid'];
    const current = getMode(target.dataset.id, 'faction');
    await setMode(target.dataset.id, 'faction', modes[(modes.indexOf(current) + 1) % 3]);
  }

  static async #onDelete(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const { id, type } = target.dataset;
    if (!await Core.confirmDelete(game.i18n.localize(`${MODULE_ID}.confirm.delete-title`), game.i18n.localize(`${MODULE_ID}.confirm.delete-${type}`))) return;
    if (type === 'faction') await Core.deleteFaction(id);
    else if (type === 'location') await Core.deleteLocation(id);
    else await Core.removeTracked(id);
    if (this.selectedId === id) { this.selectedType = null; this.selectedId = null; this._saveState(); }
  }

  static async #onUnnest(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    if (target.dataset.type === 'location') await Core.setLocationParent(target.dataset.id, null);
    else if (target.dataset.type === 'faction') await Core.setFactionParent(target.dataset.id, null);
  }

  static async #onAddChildLocation(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const loc = Core.getLocation(target.dataset.parent);
    if (!loc || Core.getValidChildLocationTypes(loc.locationType).length === 0) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.errors.cannotNest`));
      return;
    }
    import('./EntityCreatorApp.js').then(m => m.EntityCreatorApp.openLocationCreator(target.dataset.parent));
  }

  static async #onAddChildFaction(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const fac = Core.getFaction(target.dataset.parent);
    if (!fac || Core.getValidChildFactionTypes(fac.factionType).length === 0) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.errors.cannotNest`));
      return;
    }
    import('./EntityCreatorApp.js').then(m => m.EntityCreatorApp.openFactionCreator(target.dataset.parent));
  }

  static #onOpenLocationCreator() { import('./EntityCreatorApp.js').then(m => m.EntityCreatorApp.openLocationCreator()); }
  static #onOpenFactionCreator() { import('./EntityCreatorApp.js').then(m => m.EntityCreatorApp.openFactionCreator()); }
  static #onOpenActorCreator() { import('./EntityCreatorApp.js').then(m => m.EntityCreatorApp.openActorCreator()); }

  static async #onTogglePartyActive(event, target) {
    event.stopPropagation();
    if (game.user.isGM) await Core.activateParty(target.dataset.factionId);
  }

  static async #onAddMember(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const fac = Core.getFaction(target.dataset.faction);
    PickerApp.openActorPicker({
      filter: a => !(fac?.members || []).includes(a.id),
      callback: async aId => {
        const actor = game.actors.get(aId);
        if (actor && !actor.hasPlayerOwner) await Core.ensureImportant(actor);
        await Core.addFactionMember(target.dataset.faction, aId);
      }
    });
  }

  static async #onRemoveMember(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    if (!await Core.confirmDelete(game.i18n.localize(`${MODULE_ID}.confirm.delete-title`), game.i18n.localize(`${MODULE_ID}.confirm.delete-member`))) return;
    await Core.removeFactionMember(target.dataset.faction, target.dataset.actor);
  }

  static async #onAddRank(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    await Core.addFactionRank(target.dataset.faction, { name: game.i18n.localize(`${MODULE_ID}.ranks.new-rank`), color: "#6a6a6a", multiplier: 1 });
  }

  static async #onDeleteRank(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    if (!await Core.confirmDelete(game.i18n.localize(`${MODULE_ID}.confirm.delete-title`), game.i18n.localize(`${MODULE_ID}.confirm.delete-rank`))) return;
    await Core.removeFactionRank(target.dataset.faction, target.dataset.rank);
  }

  static async #onAddFactionToLoc(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const loc = Core.getLocation(target.dataset.location);
    PickerApp.openFactionPicker({ filter: f => !(loc?.factions || []).includes(f.id), callback: async fId => await Core.addFactionToLocation(target.dataset.location, fId) });
  }

  static async #onRemoveFactionFromLoc(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    if (!await Core.confirmDelete(game.i18n.localize(`${MODULE_ID}.confirm.delete-title`), game.i18n.localize(`${MODULE_ID}.confirm.remove-from-location`))) return;
    await Core.removeFactionFromLocation(target.dataset.location, target.dataset.faction);
  }

  static async #onAddActorToLoc(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const loc = Core.getLocation(target.dataset.location);
    PickerApp.openActorPicker({ filter: a => !(loc?.actors || []).includes(a.id), callback: async aId => await Core.addActorToLocation(target.dataset.location, aId) });
  }

  static async #onRemoveActorFromLoc(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    if (!await Core.confirmDelete(game.i18n.localize(`${MODULE_ID}.confirm.delete-title`), game.i18n.localize(`${MODULE_ID}.confirm.remove-from-location`))) return;
    await Core.removeActorFromLocation(target.dataset.location, target.dataset.actor);
  }

  static async #onChangeImage(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    new FilePicker({
      type: "image",
      callback: async path => {
        if (target.dataset.type === 'faction') {
          const factions = Core.getFactions();
          const f = factions.find(x => x.id === target.dataset.id);
          if (f) { f.image = path; await Core.setFactions(factions); }
        } else if (target.dataset.type === 'location') {
          const locations = Core.getLocations();
          const l = locations.find(x => x.id === target.dataset.id);
          if (l) { l.image = path; await Core.setLocations(locations); }
        }
      }
    }).render(true);
  }

  static async #onAddActorRelation(event, target) {
    event.stopPropagation();
    const entityId = target.dataset.entityId;
    if (!game.user.isGM && !canEditActor(entityId)) return;
    const relType = target.dataset.relType;
    
    PickerApp.openActorPicker({
      filter: a => a.id !== entityId,
      callback: async targetId => {
        if (relType === 'individual') {
          if (Core.getIndRel(entityId, targetId) !== undefined && Data.getData().individualRelations?.[entityId]?.[targetId] !== undefined) return;
          await Core.setIndRel(entityId, targetId, 0);
        } else if (relType === 'faction') {
          if (Data.getData().factionRelations?.[entityId]?.[targetId] !== undefined) return;
          await Core.setFactionRel(entityId, targetId, 0);
        }
      }
    });
  }

  static async #onAddFactionRelation(event, target) {
    event.stopPropagation();
    const entityId = target.dataset.entityId;
    if (!game.user.isGM && !canEditActor(entityId)) return;
    
    PickerApp.openFactionPicker({
      callback: async factionId => {
        if (Data.getData().actorFactionRelations?.[entityId]?.[factionId] !== undefined) return;
        await Core.setActorFactionRel(entityId, factionId, 0);
      }
    });
  }

  static async #onAddFactionToFactionRelation(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const entityId = target.dataset.entityId;
    
    PickerApp.openFactionPicker({
      filter: f => f.id !== entityId,
      callback: async targetFactionId => {
        if (Data.getData().factionToFactionRelations?.[entityId]?.[targetFactionId] !== undefined) return;
        await Core.setFactionToFactionRel(entityId, targetFactionId, 0);
      }
    });
  }

  static async #onRemoveRelation(event, target) {
    event.stopPropagation();
    
    const { relType, entityId, targetId } = target.dataset;
    if (!game.user.isGM && !canEditActor(entityId)) return;
    
    if (relType === 'individual') {
      await Core.removeIndRel(entityId, targetId);
    } else if (relType === 'faction') {
      await Core.removeFactionRel(entityId, targetId);
    } else if (relType === 'actorFaction') {
      await Core.removeActorFactionRel(entityId, targetId);
    } else if (relType === 'factionToFaction') {
      await Core.removeFactionToFactionRel(entityId, targetId);
    }
  }

  static async #onAdjustRep(event, target) {
    event.stopPropagation();
    const { id, type, mode, direction } = target.dataset;
    const delta = (direction === 'plus' ? 1 : -1) * (event.ctrlKey ? 5 : 1);

    if ((mode === 'auto' || mode === 'hybrid') && (type === 'actor' || type === 'faction' || type === 'faction-to-faction')) {
      if (mode === 'auto') {
        if (type === 'actor') {
          const party = Core.getActiveParty();
          if (party) {
            const members = (party.members || []).filter(m => m !== id);
            if (members.length) await Core.addRep(id, members.map(m => m), delta);
          }
        } else if (type === 'faction' || type === 'faction-to-faction') {
          return;
        }
      } else {
        return;
      }

      const container = target.closest('.fame-bar-container');
      if (container) {
        const { getRep: getRepFn } = await import('../core/reputation.js');
        const entityId = type === 'faction-to-faction' ? id.split(':')[0] : id;
        const entityType = (type === 'faction' || type === 'faction-to-faction') ? 'faction' : 'actor';
        const newVal = getRepFn(entityId, entityType);
        this._updateBarVisual(container, newVal);
      }
      return;
    }

    const container = target.closest('.fame-bar-container');
    if (container) {
      const { min, max } = Data.getLimits();
      const valInput = container.querySelector('.fame-bar-val');
      const currentVal = valInput ? +valInput.value : 0;
      this._updateBarVisual(container, Math.max(min, Math.min(max, currentVal + delta)));
    }

    if (type === 'actor') {
      await Core.addRep(id, [], delta, { addBaseRep: true });
    } else if (type === 'faction') {
      await Core.addRep({ type: 'faction', id }, [], delta, { addBaseRep: true });
    } else if (type === 'faction-rel') {
      const [factionId, pcId] = id.split(':');
      await Core.addRep({ type: 'faction', id: factionId }, pcId, delta);
    } else if (type === 'faction-to-faction') {
      const [fId1, fId2] = id.split(':');
      await Core.addRep({ type: 'faction', id: fId1 }, { type: 'faction', id: fId2 }, delta, { notification: 'none' });
    } else if (type === 'actor-faction') {
      const [actorId, factionId] = id.split(':');
      await Core.addRep(actorId, { type: 'faction', id: factionId }, delta);
    } else if (type === 'individual') {
      const [entityId, pcId] = id.split(':');
      await Core.addRep(entityId, pcId, delta);
    }
  }

  static #onToggleDescriptionEdit(event, target) {
    event.stopPropagation();
    const entityId = target.dataset.entityId;
    const entityType = target.dataset.entityType;
    if (!game.user.isGM && !(entityType === 'actor' && canEditActor(entityId))) return;
    const key = `${target.dataset.entityType}:${target.dataset.entityId}`;
    if (this._editingDescriptions.has(key)) {
      this._editingDescriptions.delete(key);
    } else {
      this._editingDescriptions.add(key);
    }
    this.render();
  }

  static DEFAULT_OPTIONS = {
    id: "fame-relations-viewer",
    classes: ["fame-relations-viewer", "standard-form"],
    position: { width: 1024, height: 768 },
    window: { icon: "fa-solid fa-users", resizable: true },
    actions: {
      selectEntity: RelationsViewerApp.#onSelectEntity,
      toggleNavGroup: RelationsViewerApp.#onToggleNavGroup,
      toggleTreeExpand: RelationsViewerApp.#onToggleTreeExpand,
      toggleCharacterGrouping: RelationsViewerApp.#onToggleCharacterGrouping,
      toggleNpcGroup: RelationsViewerApp.#onToggleNpcGroup,
      toggleRelGroup: RelationsViewerApp.#onToggleRelGroup,
      toggleDetailSection: RelationsViewerApp.#onToggleDetailSection,
      cycleActorMode: RelationsViewerApp.#onCycleActorMode,
      cycleFactionMode: RelationsViewerApp.#onCycleFactionMode,
      delete: RelationsViewerApp.#onDelete,
      addMember: RelationsViewerApp.#onAddMember,
      removeMember: RelationsViewerApp.#onRemoveMember,
      addRank: RelationsViewerApp.#onAddRank,
      deleteRank: RelationsViewerApp.#onDeleteRank,
      addFactionToLoc: RelationsViewerApp.#onAddFactionToLoc,
      removeFactionFromLoc: RelationsViewerApp.#onRemoveFactionFromLoc,
      addActorToLoc: RelationsViewerApp.#onAddActorToLoc,
      removeActorFromLoc: RelationsViewerApp.#onRemoveActorFromLoc,
      changeImage: RelationsViewerApp.#onChangeImage,
      adjustRep: RelationsViewerApp.#onAdjustRep,
      toggleHidden: RelationsViewerApp.#onToggleHidden,
      toggleRelationHidden: RelationsViewerApp.#onToggleRelationHidden,
      toggleMemberHidden: RelationsViewerApp.#onToggleMemberHidden,
      toggleLocationItemHidden: RelationsViewerApp.#onToggleLocationItemHidden,
      openLocationCreator: RelationsViewerApp.#onOpenLocationCreator,
      openFactionCreator: RelationsViewerApp.#onOpenFactionCreator,
      openActorCreator: RelationsViewerApp.#onOpenActorCreator,
      unnest: RelationsViewerApp.#onUnnest,
      addChildLocation: RelationsViewerApp.#onAddChildLocation,
      addChildFaction: RelationsViewerApp.#onAddChildFaction,
      goToOwner: RelationsViewerApp.#onGoToOwner,
      openActorSheet: RelationsViewerApp.#onOpenActorSheet,
      togglePartyActive: RelationsViewerApp.#onTogglePartyActive,
      setLocationControl: RelationsViewerApp.#onSetLocationControl,
      clearLocationControl: RelationsViewerApp.#onClearLocationControl,
      addActorRelation: RelationsViewerApp.#onAddActorRelation,
      addFactionRelation: RelationsViewerApp.#onAddFactionRelation,
      addFactionToFactionRelation: RelationsViewerApp.#onAddFactionToFactionRelation,
      removeRelation: RelationsViewerApp.#onRemoveRelation,
      toggleDescriptionEdit: RelationsViewerApp.#onToggleDescriptionEdit,
    }
  };
}