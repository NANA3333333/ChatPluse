import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const assetBase = '/assets/pixel-world/kenney-rpg-urban';
const generatedBase = '/assets/pixel-world/generated-commercial';
const generatedRoomBase = '/assets/pixel-world/generated-rooms';
const commercialV2Base = '/assets/pixel-world/commercial-street-v2';
const commercialV2AssetVersion = 'greenery-edgefix-20260520';
const commercialV2Asset = (path) => `${commercialV2Base}/${path}?v=${commercialV2AssetVersion}`;
const commercialV2StorageKey = 'pixelWorld.commercialStreetV2.layout';
const commercialV2CanvasStorageKey = 'pixelWorld.commercialStreetV2.canvas';
const commercialV2ResetBackupStorageKey = 'pixelWorld.commercialStreetV2.resetBackup';
const commercialV2DefaultSnapshotStorageKey = 'pixelWorld.commercialStreetV2.defaultSnapshot';
const commercialV2MaxStorageBytes = 500000;
const commercialV2MaxSavedItems = 250;
const commercialV2RecoveredLayoutUrl = '/recovered-commercial-layout.json';
const commercialV2RecoveredCanvasUrl = '/recovered-commercial-canvas.json';
const commercialV2SegmentSize = { width: 2048, height: 420 };
const commercialV2StageBottomPadding = 5;
const commercialV2LoopSeamMargin = 10;
const commercialV2MinSegmentCount = 1;
const commercialV2MaxSegmentCount = 24;
const commercialV2BackgroundColor = '#f4ead8';
const commercialV2PlayerFrameOrder = ['idle', 'step_a', 'passing', 'step_b'];
const commercialV2PlayerSize = { width: 64, height: 80, footOffset: 8 };
const commercialV2PlayerPeerCollision = { widthRatio: 0.42, minWidth: 28, heightRatio: 2.8, minHeight: 42 };
const commercialV2PlayerInitial = { x: 3500, y: 640, direction: 'front', frame: 0, moving: false, stepTime: 0 };
const commercialV2PlayerCharacters = [
  {
    id: 'casual-boy-v1',
    label: '男孩',
    spriteBase: '/assets/pixel-world/characters/casual-boy-v1/frames-64x80',
    assetVersion: 'character-recut-generated-sheet-20260521',
    initial: { x: 3760, y: 640, direction: 'front' }
  },
  {
    id: 'pink-cardigan-girl-v1',
    label: '粉色开衫女孩',
    spriteBase: '/assets/pixel-world/characters/pink-cardigan-girl-v1/frames-64x80',
    assetVersion: 'pink-cardigan-girl-v1-20260524',
    initial: { x: 3508, y: 640, direction: 'front' }
  }
];
const commercialV2DefaultControlledPlayerId = 'pink-cardigan-girl-v1';
const commercialV2RoleActorId = 'casual-boy-v1';
const commercialV2UserActorId = 'pink-cardigan-girl-v1';
const commercialV2BehaviorConfigStorageKey = 'pixelWorld.commercialStreetV2.behaviorTreeConfig';
const commercialV2BehaviorTreeStorageKey = 'pixelWorld.commercialStreetV2.behaviorTreeState';
const commercialV2BehaviorInteractionDistance = 170;
const commercialV2BehaviorAutonomousInitialDelayMs = 2500;
const commercialV2BehaviorAutonomousCooldownMs = 8500;
const commercialV2BehaviorNearbyCooldownMs = 4200;
const commercialV2BehaviorBaseWaitMs = 550;
const commercialV2BehaviorBaseFallbackMs = 550;
const commercialV2BehaviorActions = [
  { id: 'greet', label: '打招呼', hint: '让角色停下来看向玩家' },
  { id: 'small_talk', label: '闲聊', hint: '从街区近况切入' },
  { id: 'ask_current_action', label: '在干嘛', hint: '询问角色当前意图' },
  { id: 'ask_destination', label: '去哪儿', hint: '追问下一步目的地' },
  { id: 'suggest_destination', label: '跟我来', hint: '玩家指定一个街区地点' },
  { id: 'request_company', label: '陪我一下', hint: '触发陪伴/同行枝丫' },
  { id: 'treat_food', label: '请你吃', hint: '触发去餐饮点和好感变化' },
  { id: 'request_help', label: '帮我一下', hint: '生成帮忙/跑腿枝丫' },
  { id: 'joke', label: '开玩笑', hint: '触发轻松反应' },
  { id: 'comfort', label: '安慰我', hint: '触发近距离安抚' }
];
const commercialV2BehaviorActionIds = new Set(commercialV2BehaviorActions.map((action) => action.id));
const commercialV2BehaviorPrimaryActionIds = ['greet', 'small_talk', 'ask_current_action', 'ask_destination'];
const commercialV2BehaviorContextActionIds = ['suggest_destination', 'request_company', 'treat_food', 'request_help', 'joke', 'comfort'];
const commercialV2BehaviorImportantPlaceIds = new Set([
  'hacker',
  'casino',
  'school_factory',
  'home_exit',
  'agency',
  'convenience',
  'restaurant',
  'hospital'
]);
const commercialV2BehaviorMovementActions = [
  { id: 'go_to_place', label: '前往地点', needs: ['place_id'], description: '走到某个表内地点附近。' },
  { id: 'wander_between', label: '两点间闲逛', needs: ['from_place_id', 'to_place_id'], description: '在两个表内地点之间来回平移。' },
  { id: 'loop_in_front_of', label: '门前循环', needs: ['place_id'], description: '在某个表内地点前面小范围左右移动。' },
  { id: 'browse_near', label: '附近浏览', needs: ['place_id'], description: '靠近某个表内地点，停停走走。' },
  { id: 'patrol_segment', label: '街段巡逻', needs: ['from_place_id', 'to_place_id'], description: '在两个表内地点之间巡逻式移动。' },
  { id: 'approach_player', label: '靠近玩家', needs: [], description: '靠近玩家并面对玩家。' },
  { id: 'follow_player', label: '跟随玩家', needs: [], description: '跟随玩家，保持一小段距离。' },
  { id: 'walk_with_player', label: '陪玩家走', needs: ['to_place_id?'], description: '和玩家一起向某个表内地点走，地点可选。' },
  { id: 'idle_at_place', label: '地点停留', needs: ['place_id'], description: '在某个表内地点附近站立、等待、转向或说话。' }
];
const commercialV2BehaviorSpecialNodeIds = [
  'player_interaction'
];
const commercialV2BehaviorBaseNodeIds = [
  'hard_needs',
  'routine_goal',
  'place_affordance',
  'background_mood',
  'curiosity',
  'wander',
  'idle_micro'
];
const commercialV2BehaviorRootNodeIds = [
  ...commercialV2BehaviorSpecialNodeIds,
  ...commercialV2BehaviorBaseNodeIds
];
const commercialV2BehaviorAutonomousNodeIds = [
  'base_needs_cafe_snack',
  'base_needs_home_rest',
  'base_routine_home_agency',
  'base_routine_sign_check',
  'base_wander_convenience_cafe',
  'base_loop_cafe_front',
  'base_patrol_agency_shop',
  'base_affordance_agency_window',
  'base_affordance_cafe_pause',
  'base_background_walk_cafe',
  'base_background_slow_down',
  'base_curiosity_player_glance',
  'base_curiosity_window_watch',
  'base_idle_watch_street',
  'base_idle_turn_pause'
];
const commercialV2BehaviorNearbyAutonomousNodeIds = [
  'base_curiosity_player_glance',
  'base_idle_watch_street',
  'base_loop_cafe_front',
  'base_affordance_agency_window',
  'base_wander_convenience_cafe'
];
const commercialV2BehaviorDefaultBaseActionNodeIds = [
  'base_needs_cafe_snack',
  'base_needs_home_rest',
  'base_routine_home_agency',
  'base_routine_sign_check',
  'base_affordance_agency_window',
  'base_affordance_cafe_pause',
  'base_background_walk_cafe',
  'base_background_slow_down',
  'base_curiosity_player_glance',
  'base_curiosity_window_watch',
  'base_wander_convenience_cafe',
  'base_loop_cafe_front',
  'base_patrol_agency_shop',
  'base_idle_watch_street',
  'base_idle_turn_pause'
];
const commercialV2BehaviorLastDemoBranch = {
  branch_id: 'greet_flustered_cafe_20260530',
  title: '咖啡馆前被Nana打招呼，慌乱回应',
  priority: 90,
  ttl_ms: 45000,
  trigger: {
    player_action: 'greet',
    place_id: 'restaurant'
  },
  summary: '昨晚那张照片之后第一次在现实里碰面，脑子还没准备好怎么面对她，被打招呼的瞬间整个人僵了一下。',
  steps: [
    { action: 'go_to_place', place_id: 'restaurant', movement_style: 'hesitating' },
    { action: 'emote', text: '脚步顿了一下，视线闪躲' },
    { action: 'face_player' },
    { action: 'wait', duration_ms: 1200 },
    { action: 'say', text: '……你怎么在这。' },
    { action: 'emote', text: '耳尖微红，把手插进口袋里' },
    { action: 'say', text: '昨晚……算了，没事。吃了吗。' },
    { action: 'idle_at_place', place_id: 'restaurant', movement_style: 'slow' },
    {
      action: 'offer_choices',
      choices: [
        { id: 'sit_down', label: '一起进去坐坐？', trigger: 'request_company' },
        { id: 'ask_photo', label: '昨晚那个……', trigger: 'small_talk' },
        { id: 'leave_quietly', label: '不打扰你了', trigger: 'comfort' },
        { id: 'treat_coffee', label: '请你喝咖啡', trigger: 'treat_food' }
      ]
    }
  ]
};
function createCommercialV2PresetInteractionBranch(actionId, placeId = 'restaurant', placeLabel = '街区') {
  const safeActionId = commercialV2BehaviorActionIds.has(actionId) ? actionId : 'greet';
  const targetPlaceId = String(placeId || 'restaurant');
  const targetPlaceLabel = String(placeLabel || '街区');
  const commonChoices = [
    { id: 'ask_more', label: '继续问他', trigger: 'small_talk', place_id: targetPlaceId },
    { id: 'walk_together', label: '一起走走', trigger: 'request_company', place_id: targetPlaceId },
    { id: 'tease_lightly', label: '逗他一下', trigger: 'joke', place_id: targetPlaceId },
    { id: 'comfort_softly', label: '认真回应', trigger: 'comfort', place_id: targetPlaceId }
  ];
  const templates = {
    greet: {
      title: '预制：靠近打招呼',
      summary: '玩家靠近角色并打招呼，角色先给一个短回应，再等待玩家选择后续。',
      steps: [
        { action: 'face_player' },
        { action: 'emote', text: '停下脚步，抬眼看向你' },
        { action: 'say', text: '你来了。刚刚一直在这附近吗？' },
        { action: 'offer_choices', text: '你要怎么接话？', choices: commonChoices }
      ]
    },
    small_talk: {
      title: '预制：街边闲聊',
      summary: '玩家发起闲聊，角色用街区当前气氛接住话题。',
      steps: [
        { action: 'face_player' },
        { action: 'say', text: '今天这条街有点吵，但还挺适合闲逛。' },
        { action: 'emote', text: '往街边看了一眼，又把注意力放回你身上' },
        { action: 'offer_choices', text: '你想聊什么？', choices: [
          { id: 'ask_street', label: '问街上情况', trigger: 'ask_current_action', place_id: targetPlaceId },
          { id: 'ask_mood', label: '问他心情', trigger: 'small_talk', place_id: targetPlaceId },
          { id: 'invite_walk', label: '边走边聊', trigger: 'request_company', place_id: targetPlaceId },
          { id: 'joke_back', label: '开个玩笑', trigger: 'joke', place_id: targetPlaceId }
        ] }
      ]
    },
    ask_current_action: {
      title: '预制：问他在干嘛',
      summary: '玩家询问角色当前行动，角色先解释自己正在做什么。',
      steps: [
        { action: 'face_player' },
        { action: 'say', text: '没什么特别的，在把今天要做的事排一下。' },
        { action: 'say', text: `刚好走到${targetPlaceLabel}附近，就顺路看看。` },
        { action: 'offer_choices', text: '你要怎么继续？', choices: [
          { id: 'ask_detail', label: '追问细节', trigger: 'ask_current_action', place_id: targetPlaceId },
          { id: 'help_him', label: '说我帮你', trigger: 'request_help', place_id: targetPlaceId },
          { id: 'go_elsewhere', label: '叫他换地方', trigger: 'suggest_destination', place_id: targetPlaceId },
          { id: 'stay_with_him', label: '陪他一会儿', trigger: 'request_company', place_id: targetPlaceId }
        ] }
      ]
    },
    ask_destination: {
      title: '预制：问他去哪儿',
      summary: '玩家追问角色下一步目的地，角色先给一个模糊回答。',
      steps: [
        { action: 'face_player' },
        { action: 'say', text: `可能去${targetPlaceLabel}，也可能只是路过。` },
        { action: 'emote', text: '像是在等你决定要不要一起走' },
        { action: 'offer_choices', text: '你要怎么决定？', choices: [
          { id: 'lead_place', label: `带他去${targetPlaceLabel}`, trigger: 'suggest_destination', place_id: targetPlaceId },
          { id: 'walk_with_me', label: '让他陪你走', trigger: 'request_company', place_id: targetPlaceId },
          { id: 'ask_reason', label: '问为什么去', trigger: 'small_talk', place_id: targetPlaceId },
          { id: 'tease_direction', label: '故意逗他', trigger: 'joke', place_id: targetPlaceId }
        ] }
      ]
    },
    suggest_destination: {
      title: '预制：玩家提出目的地',
      summary: '玩家邀请角色去指定地点，角色先判断要不要跟上。',
      steps: [
        { action: 'face_player' },
        { action: 'say', text: `去${targetPlaceLabel}？可以，但你别走太快。` },
        { action: 'walk_with_player', to_place_id: targetPlaceId, movement_style: 'walk_together' },
        { action: 'offer_choices', text: '到了附近以后，你要做什么？', choices: [
          { id: 'ask_arrived', label: '问他感觉', trigger: 'small_talk', place_id: targetPlaceId },
          { id: 'ask_help', label: '请他帮忙', trigger: 'request_help', place_id: targetPlaceId },
          { id: 'treat_here', label: '说请他吃点', trigger: 'treat_food', place_id: targetPlaceId },
          { id: 'keep_walking', label: '继续一起走', trigger: 'request_company', place_id: targetPlaceId }
        ] }
      ]
    },
    request_company: {
      title: '预制：请求陪伴',
      summary: '玩家想让角色陪自己一会儿，角色先靠近并回应。',
      steps: [
        { action: 'approach_player', movement_style: 'soft' },
        { action: 'face_player' },
        { action: 'say', text: '行。我陪你走一段。' },
        { action: 'offer_choices', text: '你想怎么和他相处？', choices: [
          { id: 'walk_quietly', label: '安静走一会儿', trigger: 'request_company', place_id: targetPlaceId },
          { id: 'say_worry', label: '说有点累', trigger: 'comfort', place_id: targetPlaceId },
          { id: 'ask_plan', label: '问他的计划', trigger: 'ask_current_action', place_id: targetPlaceId },
          { id: 'go_cafe', label: '去坐一下', trigger: 'treat_food', place_id: 'restaurant' }
        ] }
      ]
    },
    treat_food: {
      title: '预制：玩家请吃东西',
      summary: '玩家提出请角色吃东西，角色先接住好意。',
      steps: [
        { action: 'face_player' },
        { action: 'say', text: '你请？那我可记住了。' },
        { action: 'walk_with_player', to_place_id: targetPlaceId || 'restaurant', movement_style: 'walk_together' },
        { action: 'offer_choices', text: '你要怎么继续？', choices: [
          { id: 'order_food', label: '让他点单', trigger: 'treat_food', place_id: targetPlaceId || 'restaurant' },
          { id: 'ask_preference', label: '问他想吃什么', trigger: 'small_talk', place_id: targetPlaceId || 'restaurant' },
          { id: 'tease_debt', label: '说他欠你一次', trigger: 'joke', place_id: targetPlaceId || 'restaurant' },
          { id: 'sit_together', label: '坐下聊聊', trigger: 'request_company', place_id: targetPlaceId || 'restaurant' }
        ] }
      ]
    },
    request_help: {
      title: '预制：请求帮忙',
      summary: '玩家请角色帮忙，角色先确认事情大小。',
      steps: [
        { action: 'face_player' },
        { action: 'say', text: '帮忙可以。先说清楚，别又只告诉我一半。' },
        { action: 'emote', text: '嘴上嫌麻烦，但已经往你这边站近了点' },
        { action: 'offer_choices', text: '你要他帮什么？', choices: [
          { id: 'small_errand', label: '跑个小腿', trigger: 'request_help', place_id: targetPlaceId },
          { id: 'go_together', label: '一起过去', trigger: 'suggest_destination', place_id: targetPlaceId },
          { id: 'need_comfort', label: '其实想被安慰', trigger: 'comfort', place_id: targetPlaceId },
          { id: 'make_joke', label: '故意说得很严重', trigger: 'joke', place_id: targetPlaceId }
        ] }
      ]
    },
    joke: {
      title: '预制：开玩笑',
      summary: '玩家开玩笑试探角色反应，角色先吐槽再接梗。',
      steps: [
        { action: 'face_player' },
        { action: 'emote', text: '愣了一下，然后忍不住笑了' },
        { action: 'say', text: '你这个笑话很危险，差一点就不好笑了。' },
        { action: 'offer_choices', text: '你要怎么接梗？', choices: [
          { id: 'joke_more', label: '继续逗他', trigger: 'joke', place_id: targetPlaceId },
          { id: 'turn_serious', label: '突然认真', trigger: 'comfort', place_id: targetPlaceId },
          { id: 'invite_walk', label: '边走边闹', trigger: 'request_company', place_id: targetPlaceId },
          { id: 'ask_reaction', label: '问他笑什么', trigger: 'small_talk', place_id: targetPlaceId }
        ] }
      ]
    },
    comfort: {
      title: '预制：请求安慰',
      summary: '玩家想被安慰，角色先停下来认真回应。',
      steps: [
        { action: 'approach_player', movement_style: 'gentle' },
        { action: 'face_player' },
        { action: 'say', text: '先别急着硬撑。你说，我听着。' },
        { action: 'offer_choices', text: '你要怎么回应他？', choices: [
          { id: 'tell_truth', label: '说实话', trigger: 'comfort', place_id: targetPlaceId },
          { id: 'ask_company', label: '让他陪你', trigger: 'request_company', place_id: targetPlaceId },
          { id: 'change_topic', label: '换个轻松话题', trigger: 'small_talk', place_id: targetPlaceId },
          { id: 'pretend_ok', label: '假装没事', trigger: 'joke', place_id: targetPlaceId }
        ] }
      ]
    }
  };
  const branch = templates[safeActionId] || templates.greet;
  return {
    branch_id: `preset_${safeActionId}_${targetPlaceId}`,
    title: branch.title,
    priority: 88,
    ttl_ms: 60000,
    trigger: {
      player_action: safeActionId,
      place_id: targetPlaceId
    },
    summary: branch.summary,
    steps: branch.steps,
    branch_kind: 'special'
  };
}
const commercialV2BehaviorDefaultConfig = {
  api_endpoint: '',
  api_key: '',
  model_name: ''
};
function createCommercialV2BehaviorTreeState() {
  const nodes = {
    street_character_root: {
      id: 'street_character_root',
      type: 'PrioritySelector',
      title: '街区角色根节点',
      children_ids: commercialV2BehaviorRootNodeIds
    },
    player_interaction: {
      id: 'player_interaction',
      type: 'Selector',
      title: '玩家特殊互动枝',
      branch_kind: 'special',
      priority: 100,
      trigger: 'player_event.active',
      summary: '玩家靠近、点击互动、选择回应后，AI 只局部更新这里的后续枝丫。',
      children_ids: []
    },
    hard_needs: {
      id: 'hard_needs',
      type: 'Selector',
      title: '硬需求枝',
      branch_kind: 'base',
      priority: 82,
      trigger: 'runtime_state.need_high',
      summary: '无互动时，角色根据饥饿、精力、压力等状态选择自己的行动。',
      children_ids: ['base_needs_cafe_snack', 'base_needs_home_rest']
    },
    routine_goal: {
      id: 'routine_goal',
      type: 'Selector',
      title: '本地例行枝',
      branch_kind: 'base',
      priority: 76,
      trigger: 'runtime_state.routine_tick',
      summary: '无互动时，角色按本地默认节奏活动；不由私聊或商业街活动触发。',
      children_ids: ['base_routine_home_agency', 'base_routine_sign_check']
    },
    place_affordance: {
      id: 'place_affordance',
      type: 'Selector',
      title: '地点能力枝',
      branch_kind: 'base',
      priority: 68,
      trigger: 'location.has_affordance',
      summary: '无互动时，角色会利用附近建筑能力，例如看房源、买东西、在咖啡馆停留。',
      children_ids: ['base_affordance_agency_window', 'base_affordance_cafe_pause']
    },
    background_mood: {
      id: 'background_mood',
      type: 'Selector',
      title: '背景情绪枝',
      branch_kind: 'base',
      priority: 60,
      trigger: 'runtime_state.mood_idle',
      summary: '大输入只影响语气/轻微情绪，不因私聊或商业街活动触发移动。',
      children_ids: ['base_background_walk_cafe', 'base_background_slow_down']
    },
    curiosity: {
      id: 'curiosity',
      type: 'Selector',
      title: '好奇心枝',
      branch_kind: 'base',
      priority: 52,
      trigger: 'nearby_place_or_player',
      summary: '无互动时，角色偶尔看向玩家或看向建筑，但不直接进入对话。',
      children_ids: ['base_curiosity_player_glance', 'base_curiosity_window_watch']
    },
    wander: {
      id: 'wander',
      type: 'Selector',
      title: '自由活动枝',
      branch_kind: 'base',
      priority: 36,
      trigger: 'otherwise',
      summary: '无互动时的默认街区移动循环。',
      children_ids: ['base_wander_convenience_cafe', 'base_loop_cafe_front', 'base_patrol_agency_shop']
    },
    idle_micro: {
      id: 'idle_micro',
      type: 'Selector',
      title: '微动作枝',
      branch_kind: 'base',
      priority: 20,
      trigger: 'idle',
      summary: '没有更强目标时，角色做轻量停留，不打断玩家。',
      children_ids: ['base_idle_watch_street', 'base_idle_turn_pause']
    },
    base_needs_cafe_snack: {
      id: 'base_needs_cafe_snack',
      type: 'ActionSequence',
      title: '基础：去咖啡馆补一点能量',
      branch_kind: 'base',
      priority: 82,
      trigger: 'runtime_state.hunger_or_low_energy',
      summary: '角色无互动时，如果状态偏低，会慢慢挪到咖啡馆附近停一会儿。',
      ttl_ms: 38000,
      steps: [
        { action: 'go_to_place', place_id: 'restaurant', movement_style: 'slow' },
        { action: 'say', text: '先买点热的，脑子才转得动。', duration_ms: 1600 },
        { action: 'idle_at_place', place_id: 'restaurant', movement_style: 'resting' },
        { action: 'emote', text: '低头闻了闻咖啡香气', duration_ms: 1400 },
        { action: 'wait', duration_ms: 1800 }
      ]
    },
    base_needs_home_rest: {
      id: 'base_needs_home_rest',
      type: 'ActionSequence',
      title: '基础：回公寓门口缓一下',
      branch_kind: 'base',
      priority: 80,
      trigger: 'runtime_state.energy_low',
      summary: '角色无互动时，精力低会回公寓住宅附近短暂停留。',
      ttl_ms: 36000,
      steps: [
        { action: 'go_to_place', place_id: 'home_exit', movement_style: 'tired' },
        { action: 'say', text: '回门口站一会儿就好。', duration_ms: 1500 },
        { action: 'idle_at_place', place_id: 'home_exit', movement_style: 'quiet' },
        { action: 'emote', text: '肩膀松下来一点', duration_ms: 1300 },
        { action: 'wait', duration_ms: 1500 }
      ]
    },
    base_routine_home_agency: {
      id: 'base_routine_home_agency',
      type: 'ActionSequence',
      title: '基础：从公寓走到中介所',
      branch_kind: 'base',
      priority: 76,
      trigger: 'runtime_state.routine_tick',
      summary: '角色无互动时，按本地默认节奏在公寓住宅和房产中介所之间移动。',
      ttl_ms: 42000,
      steps: [
        { action: 'go_to_place', place_id: 'home_exit', movement_style: 'normal' },
        { action: 'emote', text: '确认了一下随身小包', duration_ms: 1200 },
        { action: 'wait', duration_ms: 800 },
        { action: 'go_to_place', place_id: 'agency', movement_style: 'normal' },
        { action: 'say', text: '看看今天窗上有没有新东西。', duration_ms: 1600 },
        { action: 'idle_at_place', place_id: 'agency', movement_style: 'checking' }
      ]
    },
    base_routine_sign_check: {
      id: 'base_routine_sign_check',
      type: 'ActionSequence',
      title: '基础：看一眼街边招牌',
      branch_kind: 'base',
      priority: 74,
      trigger: 'runtime_state.routine_tick',
      summary: '角色无互动时，会靠近便利店或中介附近看招牌，不读取商业街活动公告。',
      ttl_ms: 38000,
      steps: [
        { action: 'browse_near', place_id: 'convenience', movement_style: 'checking_notice' },
        { action: 'say', text: '这个牌子是不是换过位置？', duration_ms: 1600 },
        { action: 'wait', duration_ms: 1400 },
        { action: 'idle_at_place', place_id: 'convenience', movement_style: 'thinking' }
      ]
    },
    base_affordance_agency_window: {
      id: 'base_affordance_agency_window',
      type: 'ActionSequence',
      title: '基础：在中介所前看橱窗',
      branch_kind: 'base',
      priority: 68,
      trigger: 'location.affordance.agency',
      summary: '角色无互动时，会在房产中介所前停停走走。',
      ttl_ms: 40000,
      steps: [
        { action: 'browse_near', place_id: 'agency', movement_style: 'window_shopping' },
        { action: 'say', text: '这套采光好像还行。', duration_ms: 1500 },
        { action: 'wait', duration_ms: 1200 },
        { action: 'emote', text: '指尖在橱窗前轻轻停了一下', duration_ms: 1400 },
        { action: 'loop_in_front_of', place_id: 'agency', movement_style: 'small_loop' }
      ]
    },
    base_affordance_cafe_pause: {
      id: 'base_affordance_cafe_pause',
      type: 'ActionSequence',
      title: '基础：咖啡馆门口停顿',
      branch_kind: 'base',
      priority: 66,
      trigger: 'location.affordance.restaurant',
      summary: '角色无互动时，会在咖啡馆附近停顿，像是在犹豫要不要进去。',
      ttl_ms: 38000,
      steps: [
        { action: 'browse_near', place_id: 'restaurant', movement_style: 'hesitating' },
        { action: 'say', text: '进去坐一下……还是算了。', duration_ms: 1700 },
        { action: 'wait', duration_ms: 1400 },
        { action: 'idle_at_place', place_id: 'restaurant', movement_style: 'slow' }
      ]
    },
    base_background_walk_cafe: {
      id: 'base_background_walk_cafe',
      type: 'ActionSequence',
      title: '基础：心情放慢到咖啡馆',
      branch_kind: 'base',
      priority: 60,
      trigger: 'runtime_state.mood_idle',
      summary: '角色无互动时，根据轻量情绪在咖啡馆附近慢下来；不由私聊或商业街活动触发。',
      ttl_ms: 38000,
      steps: [
        { action: 'go_to_place', place_id: 'restaurant', movement_style: 'distracted' },
        { action: 'emote', text: '走着走着忽然慢了下来', duration_ms: 1400 },
        { action: 'wait', duration_ms: 1300 },
        { action: 'say', text: '今天街上有点安静。', duration_ms: 1500 },
        { action: 'idle_at_place', place_id: 'restaurant', movement_style: 'quiet' }
      ]
    },
    base_background_slow_down: {
      id: 'base_background_slow_down',
      type: 'ActionSequence',
      title: '基础：路过时慢下来',
      branch_kind: 'base',
      priority: 58,
      trigger: 'runtime_state.mood_idle',
      summary: '角色无互动时，轻量情绪会表现为走位节奏变化。',
      ttl_ms: 36000,
      steps: [
        { action: 'patrol_segment', from_place_id: 'agency', to_place_id: 'restaurant', movement_style: 'slow' },
        { action: 'say', text: '慢慢走也不错。', duration_ms: 1400 },
        { action: 'wait', duration_ms: 1200 },
        { action: 'patrol_segment', from_place_id: 'restaurant', to_place_id: 'agency', movement_style: 'slow' }
      ]
    },
    base_curiosity_player_glance: {
      id: 'base_curiosity_player_glance',
      type: 'ActionSequence',
      title: '基础：注意到玩家但不打断',
      branch_kind: 'base',
      priority: 52,
      trigger: 'nearby_player.no_interaction',
      summary: '角色无互动时，靠近玩家一点点，但不弹正式对话。',
      ttl_ms: 30000,
      steps: [
        { action: 'approach_player', movement_style: 'curious' },
        { action: 'face_player' },
        { action: 'emote', text: '看了你一眼，又假装在看路', duration_ms: 1600 },
        { action: 'wait', duration_ms: 900 }
      ]
    },
    base_curiosity_window_watch: {
      id: 'base_curiosity_window_watch',
      type: 'ActionSequence',
      title: '基础：看看橱窗和路人',
      branch_kind: 'base',
      priority: 50,
      trigger: 'nearby_place',
      summary: '角色无互动时，随机在当前街段附近停顿。',
      ttl_ms: 34000,
      steps: [
        { action: 'browse_near', place_id: 'convenience', movement_style: 'look_around' },
        { action: 'say', text: '便利店灯总是这么亮。', duration_ms: 1500 },
        { action: 'wait', duration_ms: 1100 },
        { action: 'idle_at_place', place_id: 'convenience', movement_style: 'watching' }
      ]
    },
    base_wander_convenience_cafe: {
      id: 'base_wander_convenience_cafe',
      type: 'ActionSequence',
      title: '基础：便利店和咖啡馆之间闲逛',
      branch_kind: 'base',
      priority: 36,
      trigger: 'otherwise',
      summary: '角色无互动时的默认平移闲逛路线。',
      ttl_ms: 42000,
      steps: [
        { action: 'wander_between', from_place_id: 'convenience', to_place_id: 'restaurant', movement_style: 'window_shopping' },
        { action: 'say', text: '从这边走过去刚好。', duration_ms: 1400 },
        { action: 'wait', duration_ms: 1100 },
        { action: 'wander_between', from_place_id: 'restaurant', to_place_id: 'convenience', movement_style: 'window_shopping' },
        { action: 'emote', text: '回头看了一眼咖啡馆门口', duration_ms: 1300 },
        { action: 'wait', duration_ms: 900 }
      ]
    },
    base_loop_cafe_front: {
      id: 'base_loop_cafe_front',
      type: 'ActionSequence',
      title: '基础：咖啡馆门前小循环',
      branch_kind: 'base',
      priority: 34,
      trigger: 'otherwise',
      summary: '角色无互动时在咖啡馆前小范围活动。',
      ttl_ms: 36000,
      steps: [
        { action: 'loop_in_front_of', place_id: 'restaurant', movement_style: 'small_loop' },
        { action: 'say', text: '菜单换了吗？', duration_ms: 1300 },
        { action: 'wait', duration_ms: 900 },
        { action: 'browse_near', place_id: 'restaurant', movement_style: 'slow' }
      ]
    },
    base_patrol_agency_shop: {
      id: 'base_patrol_agency_shop',
      type: 'ActionSequence',
      title: '基础：中介所到便利店巡街',
      branch_kind: 'base',
      priority: 32,
      trigger: 'otherwise',
      summary: '角色无互动时在中介所和便利店之间来回移动。',
      ttl_ms: 42000,
      steps: [
        { action: 'patrol_segment', from_place_id: 'agency', to_place_id: 'convenience', movement_style: 'patrol' },
        { action: 'emote', text: '像是在给自己找个理由散步', duration_ms: 1500 },
        { action: 'wait', duration_ms: 900 },
        { action: 'patrol_segment', from_place_id: 'convenience', to_place_id: 'agency', movement_style: 'patrol' }
      ]
    },
    base_idle_watch_street: {
      id: 'base_idle_watch_street',
      type: 'ActionSequence',
      title: '基础：站在街边看人流',
      branch_kind: 'base',
      priority: 20,
      trigger: 'idle',
      summary: '角色无互动时短暂停留，不主动开启对话。',
      ttl_ms: 26000,
      steps: [
        { action: 'idle_at_place', place_id: 'agency', movement_style: 'watching' },
        { action: 'say', text: '人来人往的。', duration_ms: 1300 },
        { action: 'wait', duration_ms: 1500 }
      ]
    },
    base_idle_turn_pause: {
      id: 'base_idle_turn_pause',
      type: 'ActionSequence',
      title: '基础：短暂停顿转向',
      branch_kind: 'base',
      priority: 18,
      trigger: 'idle',
      summary: '角色无互动时做极轻的站立变化。',
      ttl_ms: 22000,
      steps: [
        { action: 'idle_at_place', place_id: 'convenience', movement_style: 'idle' },
        { action: 'emote', text: '轻轻换了个站姿', duration_ms: 1200 },
        { action: 'wait', duration_ms: 1200 }
      ]
    }
  };
  return {
    tree_id: 'street_runtime_single_character',
    schema: 'full_behavior_tree_patch_v1',
    version: 1,
    root_id: 'street_character_root',
    active_node_id: '',
    nodes,
    memory: {},
    patch_history: []
  };
}
function normalizeCommercialBehaviorNodeId(value, fallback = 'node') {
  const raw = String(value || '').trim().slice(0, 80);
  const safe = raw
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || `${fallback}_${Date.now().toString(36)}`;
}
function createCommercialBehaviorPatchFromBranch(branch, source = 'manual', patchMeta = {}) {
  if (!branch || typeof branch !== 'object') return null;
  const branchId = normalizeCommercialBehaviorNodeId(branch.branch_id || branch.id || patchMeta.node_id, 'branch');
  const targetNodeId = normalizeCommercialBehaviorNodeId(patchMeta.target_node_id || patchMeta.targetNodeId || 'player_interaction', 'target');
  return {
    patch_id: normalizeCommercialBehaviorNodeId(patchMeta.patch_id || `patch_${branchId}_${Date.now().toString(36)}`, 'patch'),
    source,
    operation: 'upsert_child',
    target_node_id: targetNodeId,
    next_active_node_id: branchId,
    reason: String(patchMeta.reason || branch.summary || '').slice(0, 180),
    node: {
      id: branchId,
      type: 'ActionSequence',
      title: String(branch.title || '行为枝丫').slice(0, 80),
      priority: Number(branch.priority) || 90,
      trigger: branch.trigger || {},
      summary: String(branch.summary || '').slice(0, 180),
      ttl_ms: Number(branch.ttl_ms || branch.ttlMs) || 45000,
      steps: Array.isArray(branch.steps) ? branch.steps : [],
      branch_kind: branch.branch_kind || branch.branchKind || (targetNodeId === 'player_interaction' ? 'special' : 'base'),
      source
    },
    memory_delta: patchMeta.memory_delta || patchMeta.memoryDelta || {}
  };
}
function normalizeCommercialBehaviorPatch(rawPatch, fallbackBranch = null, source = 'ai') {
  const patch = rawPatch && typeof rawPatch === 'object' ? rawPatch : null;
  const rawNode = patch?.node && typeof patch.node === 'object' ? patch.node : null;
  const branchLike = rawNode?.steps ? rawNode : (fallbackBranch || patch?.branch || null);
  if (!branchLike) return null;
  const branch = {
    branch_id: branchLike.branch_id || branchLike.id || patch?.next_active_node_id || patch?.nextActiveNodeId,
    title: branchLike.title,
    priority: branchLike.priority,
    ttl_ms: branchLike.ttl_ms || branchLike.ttlMs,
    trigger: branchLike.trigger,
    summary: branchLike.summary,
    steps: branchLike.steps,
    branch_kind: branchLike.branch_kind || branchLike.branchKind
  };
  const normalized = createCommercialBehaviorPatchFromBranch(branch, source, {
    patch_id: patch?.patch_id || patch?.patchId,
    target_node_id: patch?.target_node_id || patch?.targetNodeId,
    reason: patch?.reason,
    memory_delta: patch?.memory_delta || patch?.memoryDelta
  });
  if (!normalized) return null;
  normalized.operation = patch?.operation || 'upsert_child';
  normalized.next_active_node_id = normalizeCommercialBehaviorNodeId(
    patch?.next_active_node_id || patch?.nextActiveNodeId || normalized.next_active_node_id,
    'active'
  );
  normalized.node.id = normalizeCommercialBehaviorNodeId(rawNode?.id || rawNode?.node_id || normalized.node.id, 'node');
  if (normalized.next_active_node_id !== normalized.node.id && !patch?.next_active_node_id && !patch?.nextActiveNodeId) {
    normalized.next_active_node_id = normalized.node.id;
  }
  return normalized;
}
function applyCommercialBehaviorTreePatch(treeState, rawPatch) {
  const patch = normalizeCommercialBehaviorPatch(rawPatch, rawPatch?.branch, rawPatch?.source || 'manual');
  if (!patch?.node?.steps?.length) return { tree: treeState || createCommercialV2BehaviorTreeState(), patch: null, activeBranch: null };
  const currentTree = treeState && typeof treeState === 'object' ? treeState : createCommercialV2BehaviorTreeState();
  const nodes = {
    ...createCommercialV2BehaviorTreeState().nodes,
    ...(currentTree.nodes || {})
  };
  const targetNodeId = nodes[patch.target_node_id] ? patch.target_node_id : 'player_interaction';
  const targetNode = nodes[targetNodeId] || { id: targetNodeId, type: 'Selector', children_ids: [] };
  const branchKind = patch.node.branch_kind || patch.node.branchKind || (targetNodeId === 'player_interaction' ? 'special' : 'base');
  nodes[patch.node.id] = {
    ...(nodes[patch.node.id] || {}),
    ...patch.node,
    id: patch.node.id,
    branch_kind: branchKind
  };
  const nextChildren = [
    patch.node.id,
    ...(Array.isArray(targetNode.children_ids) ? targetNode.children_ids : []).filter((id) => id !== patch.node.id)
  ].slice(0, 12);
  nodes[targetNodeId] = {
    ...targetNode,
    children_ids: nextChildren
  };
  const historyItem = {
    patch_id: patch.patch_id,
    source: patch.source,
    operation: patch.operation,
    target_node_id: targetNodeId,
    node_id: patch.node.id,
    title: patch.node.title,
    created_at: new Date().toISOString(),
    reason: patch.reason || ''
  };
  const nextTree = {
    ...currentTree,
    schema: 'full_behavior_tree_patch_v1',
    version: (Number(currentTree.version) || 1) + 1,
    root_id: currentTree.root_id || 'street_character_root',
    active_node_id: patch.next_active_node_id || patch.node.id,
    nodes,
    memory: {
      ...(currentTree.memory || {}),
      ...(patch.memory_delta || {}),
      last_patch_id: patch.patch_id,
      last_active_node_id: patch.next_active_node_id || patch.node.id
    },
    patch_history: [historyItem, ...((currentTree.patch_history || []).filter((item) => item.patch_id !== patch.patch_id))].slice(0, 24)
  };
  return {
    tree: nextTree,
    patch,
    activeBranch: {
      branch_id: patch.node.id,
      title: patch.node.title,
      priority: patch.node.priority,
      ttl_ms: patch.node.ttl_ms,
      trigger: patch.node.trigger || {},
      summary: patch.node.summary || '',
      steps: patch.node.steps || [],
      branch_kind: branchKind
    }
  };
}
function createCommercialBehaviorBranchFromNode(node) {
  if (!node || !Array.isArray(node.steps) || !node.steps.length) return null;
  return {
    branch_id: node.id,
    title: node.title || node.id,
    priority: node.priority,
    ttl_ms: node.ttl_ms || node.ttlMs,
    trigger: node.trigger || {},
    summary: node.summary || '',
    steps: node.steps,
    branch_kind: node.branch_kind || node.branchKind || 'base'
  };
}
const commercialV2PlayerCharacterById = new Map(commercialV2PlayerCharacters.map((character) => [character.id, character]));
const createCommercialV2PlayerState = (character) => ({
  ...commercialV2PlayerInitial,
  ...character.initial,
  id: character.id,
  characterId: character.id
});
const createCommercialV2PlayerStates = () => Object.fromEntries(
  commercialV2PlayerCharacters.map((character) => [character.id, createCommercialV2PlayerState(character)])
);
const getCommercialV2PlayerCharacter = (player) => (
  commercialV2PlayerCharacterById.get(player?.characterId || player?.id)
  || commercialV2PlayerCharacterById.get(commercialV2DefaultControlledPlayerId)
  || commercialV2PlayerCharacters[0]
);
const commercialV2PlayerFrame = (player, fileName) => {
  const character = getCommercialV2PlayerCharacter(player);
  return `${character.spriteBase}/${fileName}?v=${character.assetVersion}`;
};
function readStoredCommercialBehaviorConfig() {
  if (typeof localStorage === 'undefined') return commercialV2BehaviorDefaultConfig;
  try {
    const raw = localStorage.getItem(commercialV2BehaviorConfigStorageKey);
    if (!raw) return commercialV2BehaviorDefaultConfig;
    const parsed = JSON.parse(raw);
    return {
      ...commercialV2BehaviorDefaultConfig,
      api_endpoint: String(parsed.api_endpoint || ''),
      model_name: String(parsed.model_name || '')
    };
  } catch {
    localStorage.removeItem(commercialV2BehaviorConfigStorageKey);
    return commercialV2BehaviorDefaultConfig;
  }
}
function readStoredCommercialBehaviorTreeState() {
  const fallback = createCommercialV2BehaviorTreeState();
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(commercialV2BehaviorTreeStorageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const nodes = {
      ...fallback.nodes,
      ...(parsed.nodes || {})
    };
    delete nodes.temporary_ai_branch;
    delete nodes.city_agent_goal;
    delete nodes.memory_echo;
    delete nodes.base_schedule_home_agency;
    delete nodes.base_schedule_notice_check;
    delete nodes.base_memory_walk_cafe;
    delete nodes.base_memory_slow_down;
    nodes.street_character_root = {
      ...fallback.nodes.street_character_root,
      ...(nodes.street_character_root || {}),
      children_ids: commercialV2BehaviorRootNodeIds
    };
    nodes.player_interaction = {
      ...fallback.nodes.player_interaction,
      ...(nodes.player_interaction || {}),
      title: '玩家特殊互动枝',
      branch_kind: 'special',
      trigger: 'player_event.active'
    };
    commercialV2BehaviorBaseNodeIds.forEach((nodeId) => {
      nodes[nodeId] = {
        ...fallback.nodes[nodeId],
        ...(nodes[nodeId] || {}),
        branch_kind: 'base',
        children_ids: fallback.nodes[nodeId]?.children_ids || []
      };
    });
    commercialV2BehaviorDefaultBaseActionNodeIds.forEach((nodeId) => {
      nodes[nodeId] = fallback.nodes[nodeId];
    });
    return {
      ...fallback,
      ...parsed,
      root_id: 'street_character_root',
      nodes,
      memory: parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {},
      patch_history: Array.isArray(parsed.patch_history) ? parsed.patch_history.slice(0, 24) : []
    };
  } catch {
    localStorage.removeItem(commercialV2BehaviorTreeStorageKey);
    return fallback;
  }
}
const commercialV2DefaultPlayerScale = 2;
const commercialV2DefaultZoom = 0.85;
const commercialV2PlayerSpeed = 220;
const commercialV2BehaviorPlayerSpeed = 180;
const commercialV2LayerBaseZIndex = 10000;
const commercialV2LayerStepZIndex = 20;
const commercialV2PlayerLayerGap = 10;
const commercialV2DepthZIndexScale = 10;
const commercialV2GroundLayerZIndex = commercialV2LayerBaseZIndex - 2000;
const commercialV2PathCellSize = 24;
const commercialV2PathWaypointReach = 10;
const commercialV2PathMaxVisited = 16000;
const commercialV2StreetCruiseDistances = [840, 660, 480, 300, 160];
const commercialV2StreetCruiseLaneOffsets = [0, -24, 24, -48, 48, -72, 72, -96, 96];
const commercialV2StreetCruiseMinForward = 96;
const commercialV2StreetCruiseCenterStep = 144;
const commercialV2StreetCruiseRoadCenterRatio = 0.5;
const commercialV2StreetCruiseOffRoadPenalty = 180;
const commercialV2StreetCruiseCenterLinePenalty = 1.4;
const commercialV2MainRoadCellPenalty = 24;
const commercialV2MainRoadCenterRatio = 0.42;
const commercialV2MainRoadTargetInset = 36;
const commercialV2ForwardPathBacktrackLimit = 180;
const commercialV2ForwardPathBacktrackPenalty = 4;
const commercialV2ForwardPathOvershootTolerance = 96;
const commercialV2MovementKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright']);
const commercialV2DepthYByType = {
  建筑: 0.92,
  租房: 0.96,
  街道: 0.94,
  装饰: 0.96,
  绿化: 0.95
};
const commercialV2DepthYByAssetId = {
  prop_food_truck: 0.8,
  prop_bus_stop: 0.88,
  prop_cafe_table: 0.86,
  prop_bench: 0.86,
  prop_bicycle: 0.82,
  prop_street_lamp: 0.97,
  prop_mailbox: 0.96,
  prop_tree_green: 0.98,
  prop_tree_cherry: 0.98
};
const commercialV2OcclusionSortYRatioByAssetId = {
  prop_food_truck: 0.8
};
const commercialV2OcclusionRightCornerCapByAssetId = {
  building_apartment_villa: { startX: 0.78, maxBottom: 0.86 },
  prop_chalkboard: { startX: 0.78, maxBottom: 0.875 }
};
const commercialV2AspectRatioByAssetId = {
  prop_chalkboard: 246 / 329
};
const commercialV2SilhouetteColumnCount = 48;
const commercialV2SilhouetteAlphaThreshold = 16;
const commercialV2OcclusionDepthMargin = 6;
const commercialV2SilhouetteCache = new Map();

function getCommercialV2ItemZIndex(layerIndex) {
  return commercialV2LayerBaseZIndex + layerIndex * commercialV2LayerStepZIndex;
}

function getCommercialV2DepthZIndex(sortY, tie = 0) {
  return commercialV2LayerBaseZIndex + Math.round((Number(sortY) || 0) * commercialV2DepthZIndexScale) + tie;
}
const commercialV2CollisionByType = {
  建筑: { x: 0.08, y: 0.86, w: 0.84, h: 0.12 },
  租房: { x: 0.18, y: 0.62, w: 0.64, h: 0.34 },
  街道: { x: 0.16, y: 0.66, w: 0.68, h: 0.3 },
  装饰: { x: 0.24, y: 0.72, w: 0.52, h: 0.24 },
  绿化: { x: 0.12, y: 0.72, w: 0.76, h: 0.22 }
};
const commercialV2LegacyCollisionByAssetId = {
  building_agency: [
    { x: 0.08, y: 0.78, w: 0.84, h: 0.18 },
    { x: 0.08, y: 0.88, w: 0.84, h: 0.1 }
  ],
  building_convenience: [
    { x: 0.07, y: 0.78, w: 0.86, h: 0.18 },
    { x: 0.07, y: 0.85, w: 0.86, h: 0.11 }
  ],
  building_cafe: [
    { x: 0.06, y: 0.76, w: 0.88, h: 0.2 },
    { x: 0.06, y: 0.86, w: 0.88, h: 0.11 }
  ],
  building_apartment_villa: [
    { x: 0.08, y: 0.78, w: 0.84, h: 0.18 },
    { x: 0.08, y: 0.86, w: 0.84, h: 0.12 }
  ],
  building_hacker_den: [
    { x: 0.08, y: 0.78, w: 0.84, h: 0.18 },
    { x: 0.08, y: 0.86, w: 0.84, h: 0.12 }
  ],
  building_hospital: [
    { x: 0.08, y: 0.74, w: 0.84, h: 0.22 },
    { x: 0.08, y: 0.82, w: 0.84, h: 0.14 }
  ],
  prop_food_truck: [
    { x: 0.08, y: 0.68, w: 0.84, h: 0.25 },
    { x: 0.1, y: 0.72, w: 0.8, h: 0.14 }
  ],
  prop_bus_stop: [
    { x: 0.1, y: 0.72, w: 0.8, h: 0.22 }
  ]
};
const commercialV2CollisionByAssetId = {
  building_agency: { x: 0.08, y: 0.94, w: 0.84, h: 0.04 },
  building_convenience: { x: 0.07, y: 0.91, w: 0.86, h: 0.05 },
  building_cafe: { x: 0.06, y: 0.92, w: 0.88, h: 0.05 },
  building_fruit_shop: { x: 0.05, y: 0.78, w: 0.9, h: 0.18 },
  building_apartment_villa: { x: 0.08, y: 0.86, w: 0.84, h: 0.12 },
  building_hacker_den: { x: 0.08, y: 0.86, w: 0.84, h: 0.12 },
  building_hospital: { x: 0.03, y: 0.46, w: 0.94, h: 0.5 },
  prop_notice_board: { x: 0.14, y: 0.66, w: 0.72, h: 0.3 },
  prop_agency_sign: { x: 0.18, y: 0.68, w: 0.64, h: 0.28 },
  prop_vending_machine: { x: 0.12, y: 0.64, w: 0.76, h: 0.32 },
  prop_food_truck: { x: 0.12, y: 0.75, w: 0.76, h: 0.05 },
  prop_chalkboard: { x: 0.18, y: 0.66, w: 0.64, h: 0.3 },
  prop_cafe_table: { x: 0.14, y: 0.56, w: 0.72, h: 0.38 },
  prop_mailbox: { x: 0.18, y: 0.66, w: 0.64, h: 0.3 },
  prop_street_lamp: { x: 0.35, y: 0.78, w: 0.3, h: 0.18 },
  prop_bicycle: { x: 0.08, y: 0.58, w: 0.84, h: 0.34 },
  prop_bench: { x: 0.08, y: 0.56, w: 0.84, h: 0.36 },
  prop_flower_box: { x: 0.08, y: 0.5, w: 0.84, h: 0.42 },
  prop_bus_stop: { x: 0.12, y: 0.58, w: 0.76, h: 0.18 },
  prop_tree_green: { x: 0.36, y: 0.76, w: 0.28, h: 0.2 },
  prop_tree_cherry: { x: 0.36, y: 0.76, w: 0.28, h: 0.2 },
  prop_fruit_stall: { x: 0.08, y: 0.62, w: 0.84, h: 0.32 },
  prop_parking_bollards: { x: 0.28, y: 0.72, w: 0.44, h: 0.24 },
  prop_traffic_cone: { x: 0.24, y: 0.62, w: 0.52, h: 0.34 },
  prop_wall_poster_board: { x: 0.12, y: 0.7, w: 0.76, h: 0.24 },
  prop_road_barrier: { x: 0.06, y: 0.64, w: 0.88, h: 0.3 }
};
const commercialV2AlwaysBackLowerBodyAssetIds = new Set([
  'building_apartment_villa'
]);
const commercialV2PlaceLinkByAssetId = {
  building_agency: {
    placeId: 'agency',
    locationId: 'street',
    label: '房产中介所',
    kind: 'housing',
    anchor: { x: 0.55, y: 0.96 },
    facing: 'front',
    actions: ['咨询房源', '看房集合', '租约提醒'],
    aliases: ['中介', '中介所', '房产中介', '看房', '租房']
  },
  building_convenience: {
    placeId: 'convenience',
    locationId: 'convenience',
    label: '便利店',
    kind: 'shop',
    anchor: { x: 0.5, y: 0.96 },
    facing: 'front',
    actions: ['购物', '买速食', '补给'],
    aliases: ['便利店', '买东西', '买吃的', '补给']
  },
  building_cafe: {
    placeId: 'restaurant',
    locationId: 'restaurant',
    label: '咖啡馆',
    kind: 'food',
    anchor: { x: 0.5, y: 0.96 },
    facing: 'front',
    actions: ['就餐', '喝咖啡', '社交约见'],
    aliases: ['餐厅', '饭店', '咖啡馆', '喝咖啡', '吃饭']
  },
  building_apartment_villa: {
    placeId: 'home_exit',
    locationId: 'home',
    label: '公寓住宅',
    kind: 'home',
    anchor: { x: 0.47, y: 0.96 },
    facing: 'front',
    actions: ['回家', '休息', '离开商业街'],
    aliases: ['家', '住宅', '公寓', '回家']
  },
  building_casino: {
    placeId: 'casino',
    locationId: 'casino',
    label: '地下赌场',
    kind: 'leisure',
    anchor: { x: 0.5, y: 0.96 },
    facing: 'front',
    actions: ['赌博', '试试运气'],
    aliases: ['赌场', '赌城', '赌博']
  },
  building_hacker_den: {
    placeId: 'hacker',
    locationId: 'hacker',
    label: '黑客据点',
    kind: 'intel',
    anchor: { x: 0.52, y: 0.96 },
    facing: 'front',
    actions: ['监听情报', '处理委托'],
    aliases: ['黑客据点', '黑客', '情报']
  },
  building_school: {
    placeId: 'school_factory',
    locationId: 'school',
    locationIds: ['school', 'factory'],
    label: '夜校 / 工厂',
    kind: 'work_education',
    anchor: { x: 0.5, y: 0.96 },
    facing: 'front',
    actions: ['上课', '学习', '打工'],
    aliases: ['学校', '夜校', '学习', '工厂', '打工', '工作']
  },
  building_hospital: {
    placeId: 'hospital',
    locationId: 'hospital',
    label: '医院',
    kind: 'medical',
    anchor: { x: 0.5, y: 0.96 },
    facing: 'front',
    actions: ['治疗', '休养'],
    aliases: ['医院', '看病', '治疗']
  },
  prop_notice_board: {
    placeId: 'notice_board',
    locationId: 'street',
    label: '租房公告牌',
    kind: 'housing_notice',
    anchor: { x: 0.5, y: 1 },
    facing: 'back',
    actions: ['查看中介广告', '浏览房源'],
    aliases: ['公告牌', '租房公告', '广告牌', '房源']
  },
  prop_agency_sign: {
    placeId: 'agency_sign',
    locationId: 'street',
    label: '中介立牌',
    kind: 'housing_notice',
    anchor: { x: 0.5, y: 1 },
    facing: 'back',
    actions: ['查看房源', '读租房广告'],
    aliases: ['中介立牌', '租房牌', '房源牌']
  },
  prop_vending_machine: {
    placeId: 'vending_machine',
    locationId: 'convenience',
    label: '自动售货机',
    kind: 'shop',
    anchor: { x: 0.5, y: 1 },
    facing: 'back',
    actions: ['买饮料', '买零食'],
    aliases: ['售货机', '自动售货机', '买饮料']
  },
  prop_food_truck: {
    placeId: 'food_truck',
    locationId: 'restaurant',
    locationIds: ['restaurant', 'park'],
    label: '中央公园餐车',
    kind: 'food',
    anchor: { x: 0.55, y: 0.7 },
    facing: 'back',
    actions: ['买小吃', '点餐', '去中央公园'],
    aliases: ['餐车', '小吃车', '买小吃', '中央公园']
  },
  prop_chalkboard: {
    placeId: 'menu_board',
    locationId: 'restaurant',
    label: '菜单小黑板',
    kind: 'food_notice',
    anchor: { x: 0.5, y: 1 },
    facing: 'back',
    actions: ['看菜单'],
    aliases: ['菜单', '小黑板']
  },
  prop_cafe_table: {
    placeId: 'cafe_table',
    locationId: 'restaurant',
    label: '咖啡桌椅',
    kind: 'social',
    anchor: { x: 0.5, y: 0.72 },
    facing: 'front',
    actions: ['坐下聊天', '喝咖啡'],
    aliases: ['桌椅', '咖啡桌', '坐下']
  },
  prop_mailbox: {
    placeId: 'mailbox',
    locationId: 'street',
    locationIds: ['street', 'park'],
    label: '邮筒',
    kind: 'street_service',
    anchor: { x: 0.5, y: 1 },
    facing: 'back',
    actions: ['寄信', '查看信件', '经过中央公园'],
    aliases: ['邮筒', '邮箱', '寄信', '中央公园']
  },
  prop_bicycle: {
    placeId: 'bicycle_parking',
    locationId: 'street',
    label: '自行车停放点',
    kind: 'street_service',
    anchor: { x: 0.5, y: 1 },
    facing: 'back',
    actions: ['停放自行车', '经过'],
    aliases: ['自行车', '单车']
  },
  prop_bus_stop: {
    placeId: 'bus_stop',
    locationId: 'street',
    locationIds: ['street', 'park'],
    label: '公交站 / 中央公园入口',
    kind: 'entry',
    anchor: { x: 0.5, y: 0.95 },
    facing: 'back',
    actions: ['进入商业街', '等车', '离开商业街', '去中央公园'],
    aliases: ['公交站', '车站', '入口', '中央公园', '公园']
  },
  prop_fruit_stall: {
    placeId: 'fruit_stall',
    locationId: 'convenience',
    label: '水果摊',
    kind: 'shop',
    anchor: { x: 0.5, y: 0.9 },
    facing: 'back',
    actions: ['买水果', '买食材'],
    aliases: ['水果摊', '水果店', '买水果']
  }
};
const commercialV2TravelLabelById = {
  agency: '房产中介所',
  agency_sign: '中介立牌',
  bus_stop: '公交站 / 中央公园入口',
  cafe_table: '咖啡桌椅',
  casino: '地下赌场',
  convenience: '便利店',
  factory: '工厂（夜校）',
  food_truck: '中央公园餐车',
  fruit_stall: '水果摊',
  hacker: '黑客据点',
  home: '公寓住宅',
  home_exit: '公寓住宅',
  hospital: '医院',
  mailbox: '邮筒',
  menu_board: '菜单小黑板',
  notice_board: '租房公告牌',
  park: '中央公园入口',
  restaurant: '餐厅 / 咖啡馆',
  school: '夜校',
  school_factory: '夜校 / 工厂',
  street: '商业街',
  vending_machine: '自动售货机'
};
const getCommercialV2Loop = (stageSize) => ({
  enabled: true,
  axis: 'x',
  width: stageSize.width,
  seam: 'left-right',
  scrollPreview: 'triple-buffer',
  wrap: '((x % width) + width) % width'
});
const getCommercialV2StageSize = (segmentCount = commercialV2MinSegmentCount, items = null) => {
  const width = commercialV2SegmentSize.width * normalizeSegmentCount(segmentCount);
  const bounds = items ? getLayoutBounds(items) : null;
  return {
    width,
    height: bounds ? Math.ceil(bounds.maxY + commercialV2StageBottomPadding) : commercialV2SegmentSize.height
  };
};
const boardAssetBox = (type, width, height, index) => {
  if (type === '天空' && width > 900) {
    return { x: 0, y: -28 + index * 18, w: 2048, h: Math.round((2048 / width) * height) };
  }
  const maxWidth = type === '道路' ? 360 : 240;
  const scale = Math.min(1, maxWidth / width);
  return {
    x: (type === '道路' ? 72 : 120) + (index % 5) * (type === '道路' ? 135 : 92),
    y: (type === '道路' ? 690 : 70) + (index % 4) * (type === '道路' ? 38 : 32),
    w: Math.round(width * scale),
    h: Math.round(height * scale)
  };
};
const makeBoardAsset = (group, type, [id, name, width, height], index) => ({
  id: `${group}_${id}`,
  name,
  type,
  path: `game-ready/${group}-background-board/${id}.png`,
  box: boardAssetBox(type, width, height, index)
});
const makeSkyStripAsset = ([id, name, width, height], index) => ({
  id: `sky_${id}`,
  name,
  type: '天空',
  path: `game-ready/sky-background-board/${id}_cropped.png`,
  naturalWidth: width,
  naturalHeight: height,
  box: boardAssetBox('天空', width, height, index)
});
const commercialV2RoadAssets = [
  ['asphalt_patch', '沥青补丁', 185, 92],
  ['cracked_asphalt_patch', '裂纹路面', 183, 84],
  ['crosswalk_horizontal', '横向斑马线', 272, 200],
  ['crosswalk_vertical', '竖向斑马线', 116, 202],
  ['curb_ramp_tile', '无障碍路缘坡', 191, 112],
  ['curb_strip_short_a', '短路缘 A', 130, 30],
  ['curb_strip_short_b', '短路缘 B', 130, 30],
  ['curb_strip_short_c', '短路缘 C', 130, 34],
  ['curb_wall_long', '长路缘墙', 307, 56],
  ['lane_marking_single', '单车道线', 31, 102],
  ['manhole_cover', '圆井盖', 150, 118],
  ['puddle_decal', '路面积水', 186, 70],
  ['road_corner_inner_left', '内弯路左', 160, 175],
  ['road_corner_inner_right', '内弯路右', 157, 175],
  ['road_corner_lower_left', '下弯路左', 194, 152],
  ['road_corner_lower_right', '下弯路右', 175, 142],
  ['road_curve_outer', '外弯道路', 160, 166],
  ['road_intersection_cross', '道路十字口', 360, 164],
  ['road_lane_wide', '宽车道', 549, 150],
  ['road_strip_drain', '排水路段', 407, 95],
  ['road_strip_plain', '直道路段', 406, 96],
  ['road_t_junction', 'T 字路口', 192, 161],
  ['road_tile_dashed_line', '虚线路块', 187, 232],
  ['road_tile_double_white_line', '双白线路块', 209, 232],
  ['road_tile_plain', '普通路块', 212, 231],
  ['road_tile_yellow_line', '黄线路块', 178, 232],
  ['sidewalk_ramp_strip', '人行道坡段', 264, 91],
  ['sidewalk_transition_a', '人行道过渡 A', 190, 91],
  ['sidewalk_transition_b', '人行道过渡 B', 160, 91],
  ['sidewalk_transition_c', '人行道过渡 C', 190, 90],
  ['stone_wall_long', '石墙路缘', 362, 50],
  ['storm_drain', '排水栅', 120, 97],
  ['straight_arrow_marking', '直行箭头', 76, 113],
  ['turn_arrow_marking', '转向箭头', 104, 86],
  ['red_curb_strip', '红砖路缘', 317, 56],
  ['cobblestone_strip', '鹅卵石路带', 339, 52]
].map((entry, index) => makeBoardAsset('road', '道路', entry, index));
const commercialV2RoadExtraAssets = Array.from({ length: 119 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return {
    id: `road_extra_${number}`,
    name: `路面扩展 ${number}`,
    type: '道路',
    path: `game-ready/road-extra-background-board/road_extra_${number}.png`,
    box: boardAssetBox('道路', 128, 104, index + commercialV2RoadAssets.length)
  };
});
const commercialV2CleanCloudAssets = [
  ['clean_cloud_01', '云朵 01', 378, 56],
  ['clean_cloud_02', '云朵 02', 279, 42],
  ['clean_cloud_03', '云朵 03', 282, 47],
  ['clean_cloud_04', '云朵 04', 195, 36],
  ['clean_cloud_05', '云朵 05', 152, 37],
  ['clean_cloud_06', '云朵 06', 99, 43],
  ['clean_cloud_07', '云朵 07', 175, 52],
  ['clean_cloud_08', '云朵 08', 118, 39],
  ['clean_cloud_09', '云朵 09', 92, 37],
  ['clean_cloud_10', '云朵 10', 145, 45],
  ['clean_cloud_11', '云朵 11', 179, 45],
  ['clean_cloud_12', '云朵 12', 168, 39],
  ['clean_cloud_13', '云朵 13', 281, 57],
  ['clean_cloud_14', '云朵 14', 252, 62],
  ['clean_cloud_15', '云朵 15', 200, 55],
  ['clean_cloud_16', '云朵 16', 217, 67],
  ['clean_cloud_17', '云朵 17', 214, 55],
  ['clean_cloud_18', '云朵 18', 287, 80],
  ['clean_cloud_19', '云朵 19', 315, 92],
  ['clean_cloud_20', '云朵 20', 338, 73],
  ['clean_cloud_21', '云朵 21', 276, 68],
  ['clean_cloud_22', '云朵 22', 268, 26],
  ['clean_cloud_23', '云朵 23', 188, 26],
  ['clean_cloud_24', '云朵 24', 226, 23],
  ['clean_cloud_25', '云朵 25', 301, 24],
  ['clean_cloud_26', '云朵 26', 229, 23],
  ['clean_cloud_27', '云朵 27', 670, 64],
  ['clean_cloud_28', '云朵 28', 682, 58]
].map(([id, name, width, height], index) => ({
  id: `sky_${id}`,
  name,
  type: '天空',
  path: `game-ready/sky-clean-cloud-board/${id}.png`,
  box: boardAssetBox('天空', width, height, index + 4)
}));
const commercialV2SkyAssets = [
  ['sky_day_strip_a', '蓝天背景 A', 1464, 180],
  ['sky_day_strip_b', '蓝天背景 B', 1464, 162],
  ['sky_sunrise_strip', '日出天空', 1464, 153],
  ['sky_evening_strip', '傍晚天空', 1464, 161]
].map((entry, index) => makeSkyStripAsset(entry, index)).concat(commercialV2CleanCloudAssets);
const greeneryPath = (name) => `game-ready/greenery-background-board/${name}.png`;
const commercialV2GreeneryAssets = [
  { id: 'greenery_bush_cluster_large', name: '大灌木丛', type: '绿化', path: greeneryPath('bush_cluster_large'), box: { x: 96, y: 650, w: 180, h: 107 } },
  { id: 'greenery_bush_cluster_mixed', name: '混合灌木丛', type: '绿化', path: greeneryPath('bush_cluster_mixed'), box: { x: 298, y: 650, w: 190, h: 91 } },
  { id: 'greenery_bush_island_long_flowers', name: '花灌木带', type: '绿化', path: greeneryPath('bush_island_long_flowers'), box: { x: 520, y: 650, w: 232, h: 86 } },
  { id: 'greenery_bush_island_round_plain', name: '圆灌木岛', type: '绿化', path: greeneryPath('bush_island_round_plain'), box: { x: 780, y: 650, w: 162, h: 88 } },
  { id: 'greenery_bush_island_round_small', name: '小圆灌木岛', type: '绿化', path: greeneryPath('bush_island_round_small'), box: { x: 970, y: 650, w: 91, h: 78 } },
  { id: 'greenery_bush_island_small_flowers', name: '小花灌木岛', type: '绿化', path: greeneryPath('bush_island_small_flowers'), box: { x: 1090, y: 650, w: 138, h: 81 } },
  { id: 'greenery_bush_low_single', name: '矮灌木', type: '绿化', path: greeneryPath('bush_low_single'), box: { x: 1250, y: 650, w: 101, h: 86 } },
  { id: 'greenery_bush_round_single', name: '圆灌木', type: '绿化', path: greeneryPath('bush_round_single'), box: { x: 1380, y: 650, w: 81, h: 69 } },
  { id: 'greenery_cypress_tall', name: '高柏树', type: '绿化', path: greeneryPath('cypress_tall'), box: { x: 1490, y: 560, w: 72, h: 155 } },
  { id: 'greenery_cypress_medium', name: '中柏树', type: '绿化', path: greeneryPath('cypress_medium'), box: { x: 1588, y: 580, w: 64, h: 137 } },
  { id: 'greenery_cypress_small', name: '小柏树', type: '绿化', path: greeneryPath('cypress_small'), box: { x: 1678, y: 610, w: 57, h: 107 } },
  { id: 'greenery_flower_bush_pink', name: '粉花灌木', type: '绿化', path: greeneryPath('flower_bush_pink'), box: { x: 96, y: 760, w: 93, h: 83 } },
  { id: 'greenery_flower_bush_purple', name: '紫花灌木', type: '绿化', path: greeneryPath('flower_bush_purple'), box: { x: 218, y: 760, w: 92, h: 84 } },
  { id: 'greenery_flower_bush_white', name: '白花灌木', type: '绿化', path: greeneryPath('flower_bush_white'), box: { x: 340, y: 760, w: 94, h: 84 } },
  { id: 'greenery_flower_bush_white_small', name: '小白花灌木', type: '绿化', path: greeneryPath('flower_bush_white_small'), box: { x: 464, y: 760, w: 91, h: 83 } },
  { id: 'greenery_flower_bush_yellow', name: '黄花灌木', type: '绿化', path: greeneryPath('flower_bush_yellow'), box: { x: 588, y: 760, w: 94, h: 85 } },
  { id: 'greenery_grass_clump_flowers', name: '花草丛', type: '绿化', path: greeneryPath('grass_clump_flowers'), box: { x: 712, y: 770, w: 106, h: 76 } },
  { id: 'greenery_grass_clump_tall', name: '高草丛', type: '绿化', path: greeneryPath('grass_clump_tall'), box: { x: 850, y: 770, w: 90, h: 79 } },
  { id: 'greenery_hedge_low_cluster', name: '低矮绿篱丛', type: '绿化', path: greeneryPath('hedge_low_cluster'), box: { x: 980, y: 750, w: 137, h: 77 } },
  { id: 'greenery_hedge_strip_flowers_mixed', name: '混合花绿篱', type: '绿化', path: greeneryPath('hedge_strip_flowers_mixed'), box: { x: 1140, y: 742, w: 212, h: 90 } },
  { id: 'greenery_hedge_strip_flowers_pink_a', name: '粉花绿篱 A', type: '绿化', path: greeneryPath('hedge_strip_flowers_pink_a'), box: { x: 1380, y: 742, w: 215, h: 92 } },
  { id: 'greenery_hedge_strip_flowers_pink_b', name: '粉花绿篱 B', type: '绿化', path: greeneryPath('hedge_strip_flowers_pink_b'), box: { x: 1625, y: 742, w: 251, h: 92 } },
  { id: 'greenery_hedge_strip_flowers_white', name: '白花绿篱', type: '绿化', path: greeneryPath('hedge_strip_flowers_white'), box: { x: 96, y: 858, w: 233, h: 91 } },
  { id: 'greenery_hedge_strip_plain_a', name: '绿篱条 A', type: '绿化', path: greeneryPath('hedge_strip_plain_a'), box: { x: 360, y: 858, w: 221, h: 92 } },
  { id: 'greenery_hedge_strip_plain_b', name: '绿篱条 B', type: '绿化', path: greeneryPath('hedge_strip_plain_b'), box: { x: 612, y: 858, w: 241, h: 91 } },
  { id: 'greenery_stone_planter_bushes', name: '石砌灌木台', type: '绿化', path: greeneryPath('stone_planter_bushes'), box: { x: 884, y: 826, w: 188, h: 117 } },
  { id: 'greenery_tree_cherry_large', name: '大花树', type: '绿化', path: greeneryPath('tree_cherry_large'), box: { x: 1100, y: 562, w: 139, h: 207 } },
  { id: 'greenery_tree_cherry_medium', name: '中花树', type: '绿化', path: greeneryPath('tree_cherry_medium'), box: { x: 1265, y: 615, w: 118, h: 166 } },
  { id: 'greenery_tree_green_large', name: '大绿树', type: '绿化', path: greeneryPath('tree_green_large'), box: { x: 1410, y: 540, w: 131, h: 223 } },
  { id: 'greenery_tree_green_medium', name: '中绿树', type: '绿化', path: greeneryPath('tree_green_medium'), box: { x: 1570, y: 595, w: 118, h: 181 } },
  { id: 'greenery_tree_green_small', name: '小绿树', type: '绿化', path: greeneryPath('tree_green_small'), box: { x: 1715, y: 630, w: 103, h: 149 } },
  { id: 'greenery_wood_planter_flower_hedge_long', name: '长木花槽', type: '绿化', path: greeneryPath('wood_planter_flower_hedge_long'), box: { x: 96, y: 920, w: 298, h: 87 } },
  { id: 'greenery_wood_planter_flowers_small', name: '木花箱灌木', type: '绿化', path: greeneryPath('wood_planter_flowers_small'), box: { x: 430, y: 920, w: 151, h: 89 } }
];
const streetClutterPath = (name) => `game-ready/street-clutter/${name}.png`;
const commercialV2StreetClutterAssets = [
  { id: 'prop_trash_bin', name: '垃圾桶', type: '街道', path: streetClutterPath('prop_trash_bin'), box: { x: 1840, y: 596, w: 70, h: 96 } },
  { id: 'prop_utility_pole_flyers', name: '招贴电线杆', type: '街道', path: streetClutterPath('prop_utility_pole_flyers'), box: { x: 1888, y: 354, w: 56, h: 150 } },
  { id: 'prop_parking_bollards', name: '停车桩', type: '街道', path: streetClutterPath('prop_parking_bollards'), box: { x: 1700, y: 520, w: 46, h: 120 } },
  { id: 'prop_delivery_box', name: '外卖箱', type: '街道', path: streetClutterPath('prop_delivery_box'), box: { x: 1382, y: 650, w: 92, h: 88 } },
  { id: 'prop_shopping_bag', name: '购物纸袋', type: '街道', path: streetClutterPath('prop_shopping_bag'), box: { x: 720, y: 660, w: 60, h: 92 } },
  { id: 'prop_takeout_cup', name: '外带饮料杯', type: '街道', path: streetClutterPath('prop_takeout_cup'), box: { x: 790, y: 672, w: 50, h: 77 } },
  { id: 'prop_sidewalk_menu_sign', name: '街边菜单牌', type: '街道', path: streetClutterPath('prop_sidewalk_menu_sign'), box: { x: 1010, y: 268, w: 86, h: 106 } },
  { id: 'prop_traffic_cone', name: '施工锥', type: '街道', path: streetClutterPath('prop_traffic_cone'), box: { x: 1628, y: 650, w: 66, h: 88 } },
  { id: 'prop_parcel_locker', name: '快递柜', type: '街道', path: streetClutterPath('prop_parcel_locker'), box: { x: 1508, y: 528, w: 116, h: 136 } },
  { id: 'prop_cardboard_boxes', name: '纸箱堆', type: '街道', path: streetClutterPath('prop_cardboard_boxes'), box: { x: 1330, y: 610, w: 108, h: 104 } },
  { id: 'prop_wall_poster_board', name: '墙面招贴板', type: '街道', path: streetClutterPath('prop_wall_poster_board'), box: { x: 664, y: 240, w: 112, h: 100 } },
  { id: 'prop_road_barrier', name: '道路护栏', type: '街道', path: streetClutterPath('prop_road_barrier'), box: { x: 1760, y: 666, w: 132, h: 88 } }
];
const largeLifePropPath = (name) => `game-ready/large-life-props-simple/${name}.png`;
const commercialV2LargeLifePropAssets = [
  { id: 'prop_simple_parcel_locker', name: '简化快递柜', type: '街道', path: largeLifePropPath('prop_simple_parcel_locker'), box: { x: 1532, y: 486, w: 210, h: 179 } },
  { id: 'prop_simple_bulletin_board', name: '简化公告栏', type: '街道', path: largeLifePropPath('prop_simple_bulletin_board'), box: { x: 96, y: 454, w: 218, h: 183 } },
  { id: 'prop_simple_recycling_bins', name: '简化回收站', type: '街道', path: largeLifePropPath('prop_simple_recycling_bins'), box: { x: 1730, y: 522, w: 204, h: 153 } },
  { id: 'prop_simple_produce_stand', name: '简化果蔬架', type: '街道', path: largeLifePropPath('prop_simple_produce_stand'), box: { x: 1360, y: 568, w: 210, h: 189 } },
  { id: 'prop_simple_bike_shelter', name: '简化自行车棚', type: '街道', path: largeLifePropPath('prop_simple_bike_shelter'), box: { x: 286, y: 514, w: 208, h: 173 } },
  { id: 'prop_simple_vending_corner', name: '简化售货角', type: '街道', path: largeLifePropPath('prop_simple_vending_corner'), box: { x: 1278, y: 250, w: 218, h: 183 } },
  { id: 'prop_simple_delivery_cart', name: '简化货箱推车', type: '街道', path: largeLifePropPath('prop_simple_delivery_cart'), box: { x: 1246, y: 586, w: 206, h: 148 } },
  { id: 'prop_simple_service_tent', name: '简化服务帐篷', type: '街道', path: largeLifePropPath('prop_simple_service_tent'), box: { x: 538, y: 548, w: 210, h: 192 } }
];
const commercialV2AssetCatalogAll = [
  { id: 'building_agency', name: '房产中介所', type: '建筑', path: 'game-ready/building_agency.png', box: { x: 18, y: 20, w: 402, h: 400 } },
  { id: 'building_convenience', name: '便利店', type: '建筑', path: 'game-ready/building_convenience.png', box: { x: 545, y: 32, w: 471, h: 378 } },
  { id: 'building_cafe', name: '咖啡馆', type: '建筑', path: 'game-ready/building_cafe.png', box: { x: 1112, y: 30, w: 396, h: 390 } },
  { id: 'building_fruit_shop', name: '水果店', type: '建筑', path: 'game-ready/building_fruit_shop.png', box: { x: 1450, y: 290, w: 330, h: 228 } },
  { id: 'building_apartment_villa', name: '公寓住宅', type: '建筑', path: 'game-ready/building_apartment_villa.png', box: { x: 1500, y: 20, w: 430, h: 412 } },
  { id: 'building_casino', name: '赌场', type: '建筑', path: 'game-ready/building_casino.png', box: { x: 520, y: 60, w: 610, h: 404 } },
  { id: 'building_hacker_den', name: '黑客据点', type: '建筑', path: 'game-ready/building_hacker_den.png', box: { x: 1190, y: 145, w: 300, h: 345 } },
  { id: 'building_school', name: '学校', type: '建筑', path: 'game-ready/building_school.png', box: { x: 80, y: 36, w: 620, h: 292 } },
  { id: 'building_hospital', name: '医院', type: '建筑', path: 'game-ready/building_hospital.png', box: { x: 690, y: 52, w: 500, h: 307 } },
  { id: 'building_factory', name: '工厂', type: '建筑', path: 'game-ready/building_factory.png', box: { x: 1260, y: 60, w: 520, h: 307 } },
  { id: 'prop_notice_board', name: '租房公告牌', type: '租房', path: 'game-ready/prop_notice_board.png', box: { x: 405, y: 240, w: 143, h: 190 } },
  { id: 'prop_agency_sign', name: '中介立牌', type: '租房', path: 'game-ready/prop_agency_sign.png', box: { x: 330, y: 250, w: 100, h: 180 } },
  { id: 'prop_vending_machine', name: '自动售货机', type: '街道', path: 'game-ready/prop_vending_machine.png', box: { x: 585, y: 250, w: 70, h: 170 } },
  { id: 'prop_food_truck', name: '餐车', type: '街道', path: 'game-ready/prop_food_truck.png', box: { x: 1480, y: 610, w: 330, h: 251 } },
  { id: 'prop_chalkboard', name: '小黑板', type: '街道', path: 'game-ready/prop_chalkboard.png', box: { x: 938, y: 262, w: 109, h: 146 } },
  { id: 'prop_cafe_table', name: '咖啡桌椅', type: '街道', path: 'game-ready/prop_cafe_table.png', box: { x: 1248, y: 318, w: 160, h: 107 } },
  { id: 'prop_mailbox', name: '邮筒', type: '街道', path: 'game-ready/prop_mailbox.png', box: { x: 1448, y: 608, w: 70, h: 140 } },
  { id: 'prop_street_lamp', name: '路灯', type: '街道', path: 'game-ready/prop_street_lamp.png', box: { x: 118, y: 512, w: 100, h: 228 } },
  { id: 'prop_bicycle', name: '自行车', type: '街道', path: 'game-ready/prop_bicycle.png', box: { x: 226, y: 646, w: 130, h: 92 } },
  { id: 'prop_bench', name: '长椅', type: '街道', path: 'game-ready/prop_bench.png', box: { x: 452, y: 666, w: 136, h: 72 } },
  { id: 'prop_flower_box', name: '花箱', type: '装饰', path: 'game-ready/prop_flower_box.png', box: { x: 632, y: 670, w: 158, h: 65 } },
  { id: 'prop_bus_stop', name: '公交站', type: '街道', path: 'game-ready/prop_bus_stop.png', box: { x: 1110, y: 532, w: 218, h: 203 } },
  { id: 'prop_tree_green', name: '绿树', type: '装饰', path: 'game-ready/prop_tree_green.png', box: { x: 0, y: 300, w: 96, h: 148 } },
  { id: 'prop_tree_cherry', name: '花树', type: '装饰', path: 'game-ready/prop_tree_cherry.png', box: { x: 1000, y: 298, w: 96, h: 150 } },
  { id: 'prop_fruit_stall', name: '水果摊', type: '街道', path: 'game-ready/prop_fruit_stall.png', box: { x: 250, y: 575, w: 155, h: 150 } },
  ...commercialV2StreetClutterAssets,
  ...commercialV2LargeLifePropAssets,
  ...commercialV2RoadAssets,
  ...commercialV2RoadExtraAssets,
  ...commercialV2SkyAssets,
  ...commercialV2GreeneryAssets
];

const _commercialV2LegacyDefaultLayout = [
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe4bv2u-24",
    "x": 5712,
    "y": 560,
    "w": 322,
    "h": 259
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe4ccxq-25",
    "x": -158,
    "y": 558,
    "w": 322,
    "h": 259
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wsqx-15",
    "x": 115,
    "y": 558,
    "w": 322,
    "h": 259
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wtip-19",
    "x": 409,
    "y": 556,
    "w": 322,
    "h": 259
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wswp-16",
    "x": 699,
    "y": 578,
    "w": 298,
    "h": 240
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wtnd-20",
    "x": 962,
    "y": 577,
    "w": 298,
    "h": 240
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wu6x-24",
    "x": 1214,
    "y": 574,
    "w": 298,
    "h": 240
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1ws7l-13",
    "x": 1466,
    "y": 578,
    "w": 298,
    "h": 240
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wt1l-17",
    "x": 1732,
    "y": 579,
    "w": 296,
    "h": 238
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wts1-21",
    "x": 1995,
    "y": 576,
    "w": 298,
    "h": 240
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wsm9-14",
    "x": 2257,
    "y": 576,
    "w": 298,
    "h": 240
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wtdd-18",
    "x": 2520,
    "y": 579,
    "w": 296,
    "h": 238
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1wtwp-22",
    "x": 2788,
    "y": 601,
    "w": 272,
    "h": 219
  },
  {
    "assetId": "sky_sky_day_strip_a",
    "id": "sky_sky_day_strip_a-mpdc262b-1",
    "x": 2942,
    "y": -180,
    "w": 6089,
    "h": 749
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdc3sya-1",
    "x": 4595,
    "y": 300,
    "w": 390,
    "h": 233,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "prop_tree_green",
    "id": "prop_tree_green-mpdlsz4k-5",
    "x": 2034,
    "y": 12,
    "w": 337,
    "h": 522,
    "collision": {
      "enabled": true,
      "x": 0.36,
      "y": 0.76,
      "w": 0.28,
      "h": 0.2
    }
  },
  {
    "assetId": "greenery_hedge_low_cluster",
    "id": "greenery_hedge_low_cluster-mpdfqyhz-2",
    "x": 4846,
    "y": 377,
    "w": 297,
    "h": 167,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.58,
      "w": 0.88,
      "h": 0.34
    }
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfkf54-9",
    "x": 4755,
    "y": 598,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "greenery_bush_cluster_mixed",
    "id": "greenery_bush_cluster_mixed-mpdfvtvi-2",
    "x": 5517,
    "y": 337,
    "w": 416,
    "h": 200,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpe1v2bd-12",
    "x": 3031,
    "y": 599,
    "w": 274,
    "h": 221
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpes6rcw-10",
    "x": -118,
    "y": 362,
    "w": 334,
    "h": 200,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpdfes4h-3",
    "x": 4146,
    "y": 480,
    "w": 916,
    "h": 215
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdd96h0-3",
    "x": 3263,
    "y": 590,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdd68p9-1",
    "x": 3637,
    "y": 459,
    "w": 170,
    "h": 138
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdiohwt-7",
    "x": 3570,
    "y": 363,
    "w": 284,
    "h": 164,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfgiw1-4",
    "x": 3512,
    "y": 596,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfgom0-5",
    "x": 3760,
    "y": 597,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfif6w-8",
    "x": 4011,
    "y": 597,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfie3c-6",
    "x": 4503,
    "y": 578,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdimzvy-5",
    "x": 4368,
    "y": 342,
    "w": 284,
    "h": 164,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdinzhz-6",
    "x": 3960,
    "y": 337,
    "w": 284,
    "h": 164,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfif28-7",
    "x": 4255,
    "y": 596,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpdfeqex-2",
    "x": 3908,
    "y": 479,
    "w": 916,
    "h": 215
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdltliq-6",
    "x": 2157,
    "y": 210,
    "w": 623,
    "h": 372,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "greenery_hedge_low_cluster",
    "id": "greenery_hedge_low_cluster-mpe6aa26-5",
    "x": 2906,
    "y": 353,
    "w": 296,
    "h": 166,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.58,
      "w": 0.88,
      "h": 0.34
    }
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpdqc0mf-4",
    "x": 2147,
    "y": 477,
    "w": 958,
    "h": 225
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdq4yr5-7",
    "x": 3124,
    "y": 365,
    "w": 245,
    "h": 146,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "greenery_hedge_low_cluster",
    "id": "greenery_hedge_low_cluster-mpeuxjr5-6",
    "x": 1344,
    "y": 213,
    "w": 471,
    "h": 262,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.58,
      "w": 0.88,
      "h": 0.34
    }
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpe659lz-8",
    "x": 1114,
    "y": 306,
    "w": 390,
    "h": 233,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpe21p0w-6",
    "x": 1192,
    "y": 473,
    "w": 978,
    "h": 233
  },
  {
    "assetId": "building_school",
    "id": "building_school-mpdlshph-1",
    "x": 1397,
    "y": 57,
    "w": 1062,
    "h": 499,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.86,
      "w": 0.84,
      "h": 0.12
    }
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpdd50d8-1",
    "x": 3066,
    "y": 480,
    "w": 916,
    "h": 215
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpe6k23f-9",
    "x": 248,
    "y": 317,
    "w": 361,
    "h": 216,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "building_agency",
    "id": "building_agency-1",
    "x": 3246,
    "y": 139,
    "w": 390,
    "h": 390,
    "collision": {
      "enabled": true,
      "x": 0.066,
      "y": 0.95,
      "w": 0.84,
      "h": 0.04
    }
  },
  {
    "assetId": "greenery_hedge_low_cluster",
    "id": "greenery_hedge_low_cluster-mpe61l5k-3",
    "x": 2329,
    "y": 437,
    "w": 274,
    "h": 154,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.58,
      "w": 0.88,
      "h": 0.34
    }
  },
  {
    "assetId": "building_convenience",
    "id": "building_convenience-1",
    "x": 3701,
    "y": 233,
    "w": 428,
    "h": 341,
    "collision": {
      "enabled": true,
      "x": 0.07,
      "y": 0.91,
      "w": 0.86,
      "h": 0.05
    }
  },
  {
    "assetId": "building_apartment_villa",
    "id": "building_apartment_villa-mpctwa7n-1",
    "x": 2518,
    "y": -1,
    "w": 620,
    "h": 596,
    "collision": {
      "enabled": true,
      "x": -0.006,
      "y": 0.86,
      "w": 1.024,
      "h": 0.14
    }
  },
  {
    "assetId": "prop_tree_green",
    "id": "prop_tree_green-1",
    "x": 3128,
    "y": 271,
    "w": 188,
    "h": 293,
    "collision": {
      "enabled": true,
      "x": 0.36,
      "y": 0.76,
      "w": 0.28,
      "h": 0.2
    }
  },
  {
    "assetId": "building_cafe",
    "id": "building_cafe-1",
    "x": 4150,
    "y": 176,
    "w": 400,
    "h": 396,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.92,
      "w": 0.88,
      "h": 0.05
    }
  },
  {
    "assetId": "prop_notice_board",
    "id": "prop_notice_board-1",
    "x": 3159,
    "y": 550,
    "w": 172,
    "h": 232,
    "collision": {
      "enabled": true,
      "x": 0.14,
      "y": 0.672,
      "w": 0.721,
      "h": 0.302
    }
  },
  {
    "assetId": "prop_agency_sign",
    "id": "prop_agency_sign-1",
    "x": 3624,
    "y": 416,
    "w": 96,
    "h": 172,
    "collision": {
      "enabled": true,
      "x": 0.18,
      "y": 0.68,
      "w": 0.64,
      "h": 0.28
    }
  },
  {
    "assetId": "prop_tree_green",
    "id": "prop_tree_green-mpc2c32q-3",
    "x": 4591,
    "y": 234,
    "w": 214,
    "h": 330,
    "collision": {
      "enabled": true,
      "x": 0.36,
      "y": 0.76,
      "w": 0.28,
      "h": 0.2
    }
  },
  {
    "assetId": "prop_chalkboard",
    "id": "prop_chalkboard-2",
    "x": 3351,
    "y": 572,
    "w": 136,
    "h": 182,
    "collision": {
      "enabled": true,
      "x": 0.065,
      "y": 0.638,
      "w": 0.893,
      "h": 0.408
    },
    "placeAnchor": {
      "x": 0.51,
      "y": 1.154
    }
  },
  {
    "assetId": "prop_vending_machine",
    "id": "prop_vending_machine-1",
    "x": 4556,
    "y": 339,
    "w": 89,
    "h": 224,
    "collision": {
      "enabled": true,
      "x": 0.12,
      "y": 0.64,
      "w": 0.76,
      "h": 0.32
    }
  },
  {
    "assetId": "prop_cafe_table",
    "id": "prop_cafe_table-1",
    "x": 3501,
    "y": 688,
    "w": 207,
    "h": 138,
    "collision": {
      "enabled": true,
      "x": 0.14,
      "y": 0.56,
      "w": 0.72,
      "h": 0.38
    }
  },
  {
    "assetId": "prop_fruit_stall",
    "id": "prop_fruit_stall-mpciwj3b-1",
    "x": 4739,
    "y": 358,
    "w": 224,
    "h": 215,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "prop_bicycle",
    "id": "prop_bicycle-1",
    "x": 3875,
    "y": 490,
    "w": 171,
    "h": 120,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.58,
      "w": 0.84,
      "h": 0.34
    }
  },
  {
    "assetId": "prop_bus_stop",
    "id": "prop_bus_stop-1",
    "x": 4411,
    "y": 499,
    "w": 317,
    "h": 296,
    "collision": {
      "enabled": true,
      "x": 0.144,
      "y": 0.691,
      "w": 0.8,
      "h": 0.22
    }
  },
  {
    "assetId": "prop_food_truck",
    "id": "prop_food_truck-mpctvuoq-1",
    "x": 3983,
    "y": 532,
    "w": 359,
    "h": 272,
    "collision": {
      "enabled": true,
      "x": 0.12,
      "y": 0.75,
      "w": 0.76,
      "h": 0.05
    },
    "placeAnchor": {
      "x": 0.488,
      "y": 1.016
    }
  },
  {
    "assetId": "prop_mailbox",
    "id": "prop_mailbox-1",
    "x": 3040,
    "y": 632,
    "w": 69,
    "h": 150,
    "collision": {
      "enabled": true,
      "x": 0.18,
      "y": 0.66,
      "w": 0.64,
      "h": 0.3
    },
    "placeAnchor": {
      "x": 0.541,
      "y": 1.136
    }
  },
  {
    "assetId": "prop_tree_green",
    "id": "prop_tree_green-mpdftrby-5",
    "x": 5311,
    "y": 93,
    "w": 332,
    "h": 513,
    "collision": {
      "enabled": true,
      "x": 0.36,
      "y": 0.76,
      "w": 0.28,
      "h": 0.2
    }
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfuhqm-10",
    "x": 4999,
    "y": 599,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfuldq-11",
    "x": 5240,
    "y": 599,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_extra_41",
    "id": "road_extra_41-mpdfupce-12",
    "x": 5477,
    "y": 601,
    "w": 280,
    "h": 226
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpe21odk-5",
    "x": 405,
    "y": 473,
    "w": 978,
    "h": 233
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpe21p6g-7",
    "x": 8,
    "y": 473,
    "w": 978,
    "h": 233
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpes7x4w-11",
    "x": 4888,
    "y": 522,
    "w": 309,
    "h": 185,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "road_road_strip_plain",
    "id": "road_road_strip_plain-mpe4b0fa-8",
    "x": -524,
    "y": 473,
    "w": 972,
    "h": 231
  },
  {
    "assetId": "greenery_bush_cluster_large",
    "id": "greenery_bush_cluster_large-mpdfv4ny-3",
    "x": 5459,
    "y": 354,
    "w": 390,
    "h": 233,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.62,
      "w": 0.84,
      "h": 0.32
    }
  },
  {
    "assetId": "building_casino",
    "id": "building_casino-mpdqd8v3-1",
    "x": 522,
    "y": 119,
    "w": 684,
    "h": 454,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.86,
      "w": 0.84,
      "h": 0.12
    }
  },
  {
    "assetId": "building_hacker_den",
    "id": "building_hacker_den-mpdqdf8v-1",
    "x": 74,
    "y": 214,
    "w": 300,
    "h": 345,
    "collision": {
      "enabled": true,
      "x": 0.08,
      "y": 0.86,
      "w": 0.84,
      "h": 0.12
    }
  },
  {
    "assetId": "sky_clean_cloud_10",
    "id": "sky_clean_cloud_10-mpe70vtc-3",
    "x": 4510,
    "y": 34,
    "w": 572,
    "h": 177
  },
  {
    "assetId": "greenery_hedge_low_cluster",
    "id": "greenery_hedge_low_cluster-mpdfwtni-3",
    "x": 5572,
    "y": 491,
    "w": 374,
    "h": 212,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.58,
      "w": 0.88,
      "h": 0.34
    }
  },
  {
    "assetId": "building_hospital",
    "id": "building_hospital-mpdfsfem-1",
    "x": 4961,
    "y": 147,
    "w": 694,
    "h": 421,
    "collision": {
      "enabled": true,
      "x": 0.029,
      "y": 0.819,
      "w": 0.994,
      "h": 0.5
    },
    "placeAnchor": {
      "x": 0.484,
      "y": 1.357
    }
  },
  {
    "assetId": "greenery_tree_green_medium",
    "id": "greenery_tree_green_medium-mpes4lgw-1",
    "x": 5580,
    "y": 457,
    "w": 202,
    "h": 310,
    "collision": {
      "enabled": true,
      "x": 0.34,
      "y": 0.76,
      "w": 0.32,
      "h": 0.2
    }
  },
  {
    "assetId": "greenery_hedge_low_cluster",
    "id": "greenery_hedge_low_cluster-mpes7r1j-6",
    "x": 4868,
    "y": 627,
    "w": 235,
    "h": 132,
    "collision": {
      "enabled": true,
      "x": 0.06,
      "y": 0.58,
      "w": 0.88,
      "h": 0.34
    }
  }
];
const commercialV2SceneAssetIds = new Set(_commercialV2LegacyDefaultLayout.map((item) => item.assetId));
const commercialV2AssetCatalog = commercialV2AssetCatalogAll.filter((asset) => commercialV2SceneAssetIds.has(asset.id));
const commercialV2AutoAppendAssetIds = new Set([
  'prop_simple_bulletin_board',
  'prop_simple_bike_shelter',
  'prop_simple_delivery_cart',
  'prop_simple_service_tent',
  'prop_simple_produce_stand',
  'prop_simple_parcel_locker',
  'prop_simple_recycling_bins',
  'prop_simple_vending_corner'
]);
const tile = (id) => `${assetBase}/tiles/tile_${id}.png`;
const generatedAsset = (path) => `${generatedBase}/${path}`;
const roomAsset = (path) => `${generatedRoomBase}/${path}`;
const roomTile = (style, name) => roomAsset(`tiles/${style}_${name}.png`);
const resolveImage = (id) => {
  const value = String(id);
  if (value.startsWith('/assets/')) return value;
  return value.includes('/') || value.endsWith('.png') ? generatedAsset(value) : tile(value);
};

const _roomMap = [
  'wwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwww',
  'ffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffff',
  'ffffffffrrrrrrrfffffffffff',
  'ffffffffrrrrrrrfffffffffff',
  'ffffffffrrrrrrrfffffffffff',
  'ffffffffrrrrrrrfffffffffff',
  'ffffffffffffffffffffffffff',
  'ffffffffffffccccccffffffff',
  'ffffffffffffccccccffffffff',
  'ffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffff'
];

const roomStyleMeta = {
  cute: {
    label: '粉甜可爱',
    subtitle: '卧室 / 书桌 / 软装 / 收纳',
    wallpaper: 'wallpaper_a',
    notes: ['可爱风适合高舒适度和亲密私聊', '粉色软装可以对应轻松、撒娇、治愈类语气', '多角度床/桌/椅已入库，后续可接角色朝向']
  },
  elegant: {
    label: '浅木典雅',
    subtitle: '卧室 / 阅读角 / 茶几 / 储物',
    wallpaper: 'wallpaper_b',
    notes: ['典雅风适合稳定租住和高秩序生活状态', '浅木家具可对应阅读、办公、休息恢复', '茶具与书架后续可接日程和记忆系统']
  },
  european: {
    label: '奶油欧式',
    subtitle: '卧室 / 壁炉 / 书车 / 古典储物',
    wallpaper: 'wallpaper_a',
    notes: ['欧式风适合高档房源和长租身份感', '壁炉、书车、地毯可以表达房间等级', '物件拆分后可按租金或装修状态替换']
  }
};

const roomPlacementZones = [
  { id: 'left-wall', name: '左墙可贴靠', x: 3.1, y: 5.3, w: 8.8, h: 7.8 },
  { id: 'back-wall', name: '后墙可贴靠', x: 11.2, y: 5.1, w: 11.5, h: 7 },
  { id: 'right-corner-block', name: '折角禁放区', x: 20.6, y: 5.25, w: 5.4, h: 7.2, blocked: true },
  { id: 'center-floor', name: '中央活动区', x: 9.1, y: 13.4, w: 12.2, h: 6.3 },
  { id: 'left-floor', name: '左侧补位区', x: 4.2, y: 14.2, w: 5.1, h: 4.2 },
  { id: 'right-floor', name: '右侧补位区', x: 20.8, y: 13.3, w: 4.2, h: 4.9 },
  { id: 'entry-path', name: '入口通道', x: 12.7, y: 17.2, w: 7.5, h: 6.4 },
  { id: 'door-block', name: '门禁放区', x: 24.4, y: 7.35, w: 4.2, h: 8.9, blocked: true },
  { id: 'entry-block', name: '入口禁放区', x: 11.9, y: 20.6, w: 8.5, h: 3.8, blocked: true }
];

const roomLayoutObjects = [
  { id: 'bed-slot', name: '床', type: 'large', x: 4.7, y: 8.2, w: 5.4, h: 3.2, facing: 'south', wallSide: 'left', anchor: 'bottom-center', collision: true },
  { id: 'nightstand-slot', name: '床头柜', type: 'small', x: 10.2, y: 9.8, w: 1.35, h: 1.2, facing: 'south', wallSide: 'left', anchor: 'bottom-center', collision: true },
  { id: 'desk-slot', name: '书桌', type: 'large', x: 13.2, y: 8.3, w: 5.1, h: 2.45, facing: 'south', wallSide: 'back', anchor: 'bottom-center', collision: true },
  { id: 'chair-slot', name: '椅子', type: 'seat', x: 15.1, y: 10.85, w: 1.55, h: 1.45, facing: 'north', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'back-bookshelf-slot', name: '矮书柜', type: 'small', x: 18.55, y: 8.1, w: 2.55, h: 1.75, facing: 'south', wallSide: 'back', anchor: 'bottom-center', collision: true },
  { id: 'corner-box-slot', name: '折角收纳', type: 'small', x: 21.15, y: 12.65, w: 1.75, h: 1.25, facing: 'south', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'rug-slot', name: '地毯', type: 'floor', x: 12.2, y: 14.5, w: 7.2, h: 3.75, facing: 'south', wallSide: 'floor', anchor: 'center', collision: false },
  { id: 'tea-table-slot', name: '茶几', type: 'small', x: 15, y: 15.55, w: 2.35, h: 1.35, facing: 'south', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'left-cabinet-slot', name: '矮柜', type: 'small', x: 5.15, y: 15.2, w: 2.25, h: 1.35, facing: 'south', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'floor-cushion-slot', name: '软垫', type: 'floor', x: 7.35, y: 16.65, w: 1.8, h: 1.25, facing: 'south', wallSide: 'floor', anchor: 'center', collision: false },
  { id: 'storage-slot', name: '收纳箱', type: 'small', x: 21.45, y: 16.1, w: 1.8, h: 1.35, facing: 'south', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'side-cabinet-slot', name: '边柜', type: 'small', x: 22.75, y: 14.15, w: 1.55, h: 1.25, facing: 'south', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'right-mat-slot', name: '小地垫', type: 'floor', x: 24.0, y: 13.9, w: 1.8, h: 1.1, facing: 'south', wallSide: 'floor', anchor: 'center', collision: false },
  { id: 'plant-slot', name: '绿植', type: 'decor', x: 22.95, y: 17.2, w: 1.25, h: 1.7, facing: 'south', wallSide: 'floor', anchor: 'bottom-center', collision: true },
  { id: 'wall-shelf-slot', name: '墙架', type: 'wall', x: 4.2, y: 5.65, w: 3.1, h: 0.9, facing: 'south', wallSide: 'left', anchor: 'wall-center', collision: false },
  { id: 'right-wall-hooks-slot', name: '墙挂钩', type: 'wall', x: 24.45, y: 9.65, w: 1.25, h: 1.15, facing: 'west', wallSide: 'right', anchor: 'wall-center', collision: false },
  { id: 'open-book-slot', name: '书本', type: 'decor', x: 18.3, y: 15.35, w: 1.2, h: 0.8, facing: 'south', wallSide: 'floor', anchor: 'center', collision: false }
];

const buildRoomScene = (style) => {
  const meta = roomStyleMeta[style];
  return {
    title: `${meta.label}居住房间`,
    subtitle: meta.subtitle,
    source: '统一空房型背景 / object-layer 规则占位 / footprint + anchor',
    assetNote: `${meta.label}房间：当前只保留统一空房型背景，家具图已移除。画面上的占位框是拼接规则层，用来约束后续素材的占地、锚点、朝向和碰撞。`,
    size: { cols: 32, rows: 25 },
    backdrop: roomAsset('backgrounds/unified-empty-room.png'),
    referenceImage: null,
    base: roomTile(style, 'floor_main'),
    palette: {
      w: roomTile(style, meta.wallpaper),
      f: roomTile(style, 'floor_main'),
      r: roomTile(style, 'floor_rug'),
      c: roomTile(style, 'floor_ceramic')
    },
    map: [],
    structures: [],
    props: [],
    placementZones: roomPlacementZones,
    layoutObjects: roomLayoutObjects,
    agents: [],
    notes: ['房间家具素材已清理，先保留空房型和规则层', '每个物件后续必须有 footprint / anchor / facing / collision', '门和入口是禁放区，后续自动摆放要先做碰撞过滤']
  };
};

const roomScenes = {
  cute: buildRoomScene('cute'),
  elegant: buildRoomScene('elegant'),
  european: buildRoomScene('european')
};

const scenes = {
  street: {
    title: '繁华商业街',
    subtitle: '商业街 / 中介所 / 餐厅 / 便利店',
    source: 'AI 生成拆解素材 / 本地透明 PNG / 64x64 地面 tile',
    assetNote: '商业街概念图拆解后的本地素材：建筑、街道道具、地面 tile 与围栏。人物素材先暂时舍弃。',
    size: { cols: 26, rows: 17 },
    base: 'tiles/tile_pavement.png',
    palette: {
      g: 'tiles/tile_grass.png',
      f: 'tiles/tile_flower_grass.png',
      p: 'tiles/tile_pavement.png',
      s: 'tiles/tile_stone_path.png',
      r: 'tiles/tile_road_soft.png',
      x: 'tiles/tile_crosswalk.png',
      w: 'tiles/tile_water.png',
      b: 'tiles/tile_wood_plank.png'
    },
    map: [
      'ggggggppppppppppppgggggg',
      'ggggggppppppppppppgggggg',
      'ggggggppppppppppppgggggg',
      'pppppppppppppppppppppppppp',
      'pppppppppppppppppppppppppp',
      'rrrrrrrrrrrrrrrrrrrrrrrrrr',
      'rrxxxrrrrrrrrrxxxrrrrrrrr',
      'rrrrrrrrrrrrrrrrrrrrrrrrrr',
      'pppppppppppppppppppppppppp',
      'gggffffppppppppppffffggg',
      'pppppppppppppppppppppppppp',
      'pppppppppppppppppppppppppp',
      'ggggggppppppppppppgggggg',
      'ggggggppppppppppppgggggg',
      'ggggggppppbbbbbbppppgggggg',
      'wwwwwwwwwwwwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwwwwwwwwwwwww'
    ],
    structures: [],
    props: [
      { id: 'pink-shop', asset: 'game-ready/building_pink_shop.png', x: 0.7, y: 0.15, w: 7, h: 6 },
      { id: 'convenience', asset: 'game-ready/building_green_convenience.png', x: 8.85, y: 0.1, w: 7.8, h: 6.15 },
      { id: 'blue-cafe', asset: 'game-ready/building_blue_cafe.png', x: 18.2, y: 0.15, w: 7, h: 6 },
      { id: 'tree-1', asset: 'game-ready/prop_tree_green.png', x: 0.2, y: 8.2, w: 2, h: 2.7 },
      { id: 'tree-2', asset: 'game-ready/prop_tree_cherry.png', x: 22.6, y: 8.1, w: 2.2, h: 2.8 },
      { id: 'lamp-1', asset: 'game-ready/prop_street_lamp.png', x: 7.3, y: 5.25, w: 0.9, h: 2.7 },
      { id: 'lamp-2', asset: 'game-ready/prop_street_lamp.png', x: 17.4, y: 5.25, w: 0.9, h: 2.7 },
      { id: 'led-24h', asset: 'game-ready/prop_led_24h.png', x: 8.15, y: 3.65, w: 0.55, h: 1.6 },
      { id: 'vending', asset: 'game-ready/prop_vending_machine.png', x: 16.95, y: 4.25, w: 0.9, h: 2.15 },
      { id: 'flower-box-1', asset: 'game-ready/prop_flower_box.png', x: 10.8, y: 8.75, w: 3, h: 2.1 },
      { id: 'cafe-table', asset: 'game-ready/prop_cafe_table.png', x: 20.2, y: 6.65, w: 2, h: 2.3 },
      { id: 'bench-1', asset: 'game-ready/prop_bench.png', x: 18.8, y: 9.5, w: 2.8, h: 1.6 },
      { id: 'fruit-stall', asset: 'game-ready/prop_fruit_stall.png', x: 2.6, y: 11.4, w: 3.3, h: 2.5 },
      { id: 'bicycle', asset: 'game-ready/prop_bicycle.png', x: 19.8, y: 6.8, w: 2.8, h: 1.8 },
      { id: 'mailbox', asset: 'game-ready/prop_mailbox.png', x: 23.6, y: 5.9, w: 1.1, h: 2.2 },
      { id: 'chalkboard', asset: 'game-ready/prop_chalkboard.png', x: 5.85, y: 4.55, w: 1.5, h: 1.8 },
      { id: 'fence-a', asset: 'tiles/fence_horizontal.png', x: 0, y: 11, w: 1, h: 1 },
      { id: 'fence-b', asset: 'tiles/fence_horizontal.png', x: 1, y: 11, w: 1, h: 1 },
      { id: 'fence-c', asset: 'tiles/fence_gate.png', x: 2, y: 11, w: 1, h: 1 },
      { id: 'fence-d', asset: 'tiles/fence_horizontal.png', x: 3, y: 11, w: 1, h: 1 },
      { id: 'fence-e', asset: 'tiles/fence_horizontal.png', x: 4, y: 11, w: 1, h: 1 },
      { id: 'railing-1', asset: 'tiles/railing_horizontal.png', x: 10, y: 14.4, w: 1, h: 1 },
      { id: 'railing-2', asset: 'tiles/railing_horizontal.png', x: 11, y: 14.4, w: 1, h: 1 },
      { id: 'railing-3', asset: 'tiles/railing_horizontal.png', x: 12, y: 14.4, w: 1, h: 1 },
      { id: 'railing-4', asset: 'tiles/railing_horizontal.png', x: 13, y: 14.4, w: 1, h: 1 }
    ],
    agents: [],
    notes: ['中介广告可以落在中介所门口', '角色去工作/吃饭/看房会先移动到对应分区', '房租压力会提高工厂和便利店权重']
  }
};

function Tile({ id }) {
  return <img className="pixel-world-tile" src={resolveImage(id)} alt="" draggable={false} />;
}

function LayerSprite({ item }) {
  return (
    <img
      className={`pixel-world-sprite ${item.wide ? 'wide' : ''}`}
      src={resolveImage(item.asset || item.tile)}
      alt=""
      draggable={false}
      style={{
        '--x': item.x,
        '--y': item.y,
        '--w': item.w || (item.wide ? 2 : 1),
        '--h': item.h || (item.tall ? 2 : 1)
      }}
    />
  );
}

function LayoutZone({ zone }) {
  return (
    <div
      className={`pixel-world-layout-zone ${zone.id}${zone.blocked ? ' blocked' : ''}`}
      style={{ '--x': zone.x, '--y': zone.y, '--w': zone.w, '--h': zone.h }}
    >
      <span>{zone.name}</span>
    </div>
  );
}

function LayoutObject({ item }) {
  return (
    <div
      className={`pixel-world-layout-object ${item.type}`}
      style={{ '--x': item.x, '--y': item.y, '--w': item.w, '--h': item.h }}
      title={`${item.name} | footprint ${item.w}x${item.h} | anchor ${item.anchor} | facing ${item.facing} | wall ${item.wallSide}`}
    >
      <span>{item.name}</span>
      <i className={`anchor ${item.anchor}`} />
      <b className={`facing ${item.facing}`} />
      {item.collision && <em>solid</em>}
    </div>
  );
}

function AgentSprite({ agent }) {
  return (
    <div
      className={`pixel-world-agent ${agent.path || ''}`}
      style={{
        '--x': agent.x,
        '--y': agent.y,
        '--hair': agent.look?.hair || '#6f4a8e',
        '--outfit': agent.look?.outfit || '#ff8fbd',
        '--accent': agent.look?.accent || '#ffd5e7'
      }}
      title={`${agent.name}: ${agent.status}`}
    >
      <div className="pixel-world-bubble">{agent.status}</div>
      {agent.look ? <Chibi /> : <img src={tile(agent.tile)} alt="" draggable={false} />}
      <span>{agent.name}</span>
    </div>
  );
}

function Chibi({ small = false, look }) {
  const style = look ? {
    '--hair': look.hair,
    '--outfit': look.outfit,
    '--accent': look.accent
  } : undefined;
  return (
    <div className={`pixel-world-chibi ${small ? 'small' : ''}`} style={style} aria-hidden="true">
      <i className="hair" />
      <i className="face" />
      <i className="body" />
      <i className="legs" />
    </div>
  );
}

function Structure({ item }) {
  const style = {
    '--x': item.x,
    '--y': item.y,
    '--w': item.w,
    '--h': item.h,
    '--roof': item.roof,
    '--trim': item.trim
  };
  if (item.kind === 'rug') {
    return <div className="pixel-world-rug" style={style} />;
  }
  if (item.kind === 'zone') {
    return <div className="pixel-world-zone" style={style}><span>{item.name}</span></div>;
  }
  if (item.kind === 'roomFrame') {
    return <div className="pixel-world-room-frame" style={style}><span>{item.name}</span></div>;
  }
  if (item.kind === 'furniture') {
    return <div className={`pixel-world-furniture ${item.type}`} style={style}><span>{item.name}</span></div>;
  }
  return (
    <div className="pixel-world-building" style={style}>
      <div className="pixel-world-building-roof" />
      <div className="pixel-world-building-body">
        <div className="pixel-world-window-row">
          <Tile id="0276" />
          <Tile id={item.sign || '0277'} />
          <Tile id="0276" />
        </div>
        <div className="pixel-world-door-row">
          <Tile id="0280" />
          <Tile id={item.door || '0283'} />
          <Tile id="0280" />
        </div>
      </div>
      <div className="pixel-world-building-name">{item.name}</div>
    </div>
  );
}

function Scene({ scene }) {
  const cells = useMemo(() => {
    const rows = scene.map || [];
    return rows.flatMap((row, y) => row.split('').map((code, x) => ({
      key: `${x}-${y}`,
      id: scene.palette[code] || scene.base
    })));
  }, [scene]);

  return (
    <div className="pixel-world-stage-wrap">
      <div
        className="pixel-world-stage"
        style={{ '--cols': scene.size.cols, '--rows': scene.size.rows }}
      >
        {scene.backdrop ? (
          <img className="pixel-world-backdrop" src={scene.backdrop} alt="" draggable={false} />
        ) : (
          <div className="pixel-world-grid">
            {cells.map((cell) => <Tile key={cell.key} id={cell.id} />)}
          </div>
        )}
        {!scene.backdrop && <div className="pixel-world-shadow-layer" />}
        {scene.structures.map((item) => <Structure key={`${item.name}-${item.x}-${item.y}`} item={item} />)}
        {(scene.placementZones || []).map((zone) => <LayoutZone key={zone.id} zone={zone} />)}
        {(scene.layoutObjects || [])
          .slice()
          .sort((a, b) => (a.y + a.h) - (b.y + b.h))
          .map((item) => <LayoutObject key={item.id} item={item} />)}
        {scene.props.map((item) => <LayerSprite key={item.id} item={item} />)}
        {scene.agents.map((agent) => <AgentSprite key={agent.id} agent={agent} />)}
      </div>
    </div>
  );
}

function readStoredCommercialLayout() {
  const defaultState = getDefaultCommercialLayoutState();
  try {
    const raw = localStorage.getItem(commercialV2StorageKey);
    if (!raw) return defaultState;
    if (raw.length > commercialV2MaxStorageBytes) {
      localStorage.removeItem(commercialV2StorageKey);
      return defaultState;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState;
    const savedCanvas = readStoredCommercialCanvas();
    const rawItems = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(rawItems)) return defaultState;
    let segmentCount = normalizeSegmentCount(
      savedCanvas?.segmentCount || parsed.segmentCount || parsed.segments || getRequiredSegmentCount(rawItems)
    );
    const assetMap = new Map(commercialV2AssetCatalog.map((asset) => [asset.id, asset]));
    let stageSize = { width: getCommercialV2StageSize(segmentCount).width, height: 1024 };
    let cleaned = rawItems
      .slice(0, commercialV2MaxSavedItems)
      .filter((item) => item && assetMap.has(item.assetId))
      .map((item) => {
        const asset = assetMap.get(item.assetId);
        return clampBox(normalizeCommercialV2ItemAspect({
          assetId: item.assetId,
          id: String(item.id || `${item.assetId}-${Date.now().toString(36)}`),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          collision: item.collision && typeof item.collision === 'object'
            ? normalizeCommercialV2Collision(migrateCommercialV2Collision(item.collision, asset), asset)
            : undefined,
          placeAnchor: normalizeCommercialV2PlaceAnchor(item.placeAnchor) || undefined,
          groundLayer: item.groundLayer === true ? true : undefined
        }, asset), stageSize);
      });
    if (!cleaned.length) {
      localStorage.removeItem(commercialV2StorageKey);
      localStorage.removeItem(commercialV2CanvasStorageKey);
      return defaultState;
    }
    if (Array.isArray(parsed)) {
      const usedAssetIds = new Set(cleaned.map((item) => item.assetId));
      const missingDefaultLifeProps = _commercialV2LegacyDefaultLayout
        .filter((item) => commercialV2AutoAppendAssetIds.has(item.assetId) && !usedAssetIds.has(item.assetId))
        .map((item) => clampBox(item, stageSize));
      cleaned = missingDefaultLifeProps.length ? [...cleaned, ...missingDefaultLifeProps] : cleaned;
    }
    const requiredSegmentCount = getRequiredSegmentCount(cleaned);
    if (requiredSegmentCount > segmentCount) {
      segmentCount = requiredSegmentCount;
      stageSize = getCommercialV2StageSize(segmentCount, cleaned);
      cleaned = cleaned.map((item) => clampBox(item, stageSize));
    }
    stageSize = getCommercialV2StageSize(segmentCount, cleaned);
    cleaned = cleaned.map((item) => clampBox(item, stageSize));
    return { segmentCount, items: cleaned };
  } catch {
    localStorage.removeItem(commercialV2StorageKey);
    return defaultState;
  }
}

function readStoredCommercialCanvas() {
  try {
    const raw = localStorage.getItem(commercialV2CanvasStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...parsed,
      segmentCount: normalizeSegmentCount(parsed.segmentCount)
    };
  } catch {
    localStorage.removeItem(commercialV2CanvasStorageKey);
    return null;
  }
}

function normalizeCommercialV2LayoutState(rawItems, segmentCountValue = commercialV2MinSegmentCount) {
  if (!Array.isArray(rawItems)) return null;
  const assetMap = new Map(commercialV2AssetCatalog.map((asset) => [asset.id, asset]));
  let segmentCount = normalizeSegmentCount(segmentCountValue || getRequiredSegmentCount(rawItems));
  let stageSize = { width: getCommercialV2StageSize(segmentCount).width, height: 1024 };
  let cleaned = rawItems
    .slice(0, commercialV2MaxSavedItems)
    .filter((item) => item && assetMap.has(item.assetId))
    .map((item) => {
      const asset = assetMap.get(item.assetId);
      return clampBox(normalizeCommercialV2ItemAspect({
        assetId: item.assetId,
        id: String(item.id || `${item.assetId}-${Date.now().toString(36)}`),
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        collision: item.collision && typeof item.collision === 'object'
          ? normalizeCommercialV2Collision(migrateCommercialV2Collision(item.collision, asset), asset)
          : undefined,
        placeAnchor: normalizeCommercialV2PlaceAnchor(item.placeAnchor) || undefined,
        groundLayer: item.groundLayer === true ? true : undefined
      }, asset), stageSize);
    });
  if (!cleaned.length) return null;
  const requiredSegmentCount = getRequiredSegmentCount(cleaned);
  if (requiredSegmentCount > segmentCount) {
    segmentCount = requiredSegmentCount;
  }
  stageSize = getCommercialV2StageSize(segmentCount, cleaned);
  cleaned = cleaned.map((item) => clampBox(item, stageSize));
  return { segmentCount, items: cleaned };
}

function readStoredCommercialResetBackup() {
  try {
    const raw = localStorage.getItem(commercialV2ResetBackupStorageKey);
    if (!raw) return null;
    if (raw.length > commercialV2MaxStorageBytes) {
      localStorage.removeItem(commercialV2ResetBackupStorageKey);
      return null;
    }
    const parsed = JSON.parse(raw);
    const normalized = normalizeCommercialV2LayoutState(parsed?.items, parsed?.segmentCount);
    if (!normalized) return null;
    return {
      ...normalized,
      selectedId: String(parsed?.selectedId || normalized.items[0]?.id || ''),
      savedAt: Number(parsed?.savedAt || Date.now())
    };
  } catch {
    localStorage.removeItem(commercialV2ResetBackupStorageKey);
    return null;
  }
}

function readStoredCommercialDefaultSnapshot() {
  try {
    const raw = localStorage.getItem(commercialV2DefaultSnapshotStorageKey);
    if (!raw) return null;
    if (raw.length > commercialV2MaxStorageBytes) {
      localStorage.removeItem(commercialV2DefaultSnapshotStorageKey);
      return null;
    }
    const parsed = JSON.parse(raw);
    const normalized = normalizeCommercialV2LayoutState(parsed?.items, parsed?.segmentCount);
    if (!normalized) return null;
    return {
      ...normalized,
      selectedId: String(parsed?.selectedId || normalized.items[0]?.id || ''),
      savedAt: Number(parsed?.savedAt || Date.now())
    };
  } catch {
    localStorage.removeItem(commercialV2DefaultSnapshotStorageKey);
    return null;
  }
}

function getBuiltInDefaultCommercialItems() {
  const assetMap = new Map(commercialV2AssetCatalog.map((asset) => [asset.id, asset]));
  const segmentCount = getRequiredSegmentCount(_commercialV2LegacyDefaultLayout);
  const stageSize = { width: getCommercialV2StageSize(segmentCount).width, height: 1024 };
  return _commercialV2LegacyDefaultLayout.map((item) => {
    const asset = assetMap.get(item.assetId);
    return clampBox(normalizeCommercialV2ItemAspect({
      ...item,
      collision: item.collision && typeof item.collision === 'object'
        ? normalizeCommercialV2Collision(migrateCommercialV2Collision(item.collision, asset), asset)
        : undefined
    }, asset), stageSize);
  });
}

function getDefaultCommercialLayoutState() {
  const savedDefault = readStoredCommercialDefaultSnapshot();
  if (savedDefault?.items?.length) return savedDefault;
  const items = getBuiltInDefaultCommercialItems();
  return {
    segmentCount: getRequiredSegmentCount(items),
    selectedId: items[0]?.id || '',
    items
  };
}

function normalizeSegmentCount(value) {
  return Math.max(
    commercialV2MinSegmentCount,
    Math.min(commercialV2MaxSegmentCount, Math.round(Number(value) || commercialV2MinSegmentCount))
  );
}

function getRequiredSegmentCount(items) {
  if (!items.length) return commercialV2MinSegmentCount;
  const rightmostAnchor = items.reduce((maxX, item) => {
    const x = Number(item.x || 0);
    const w = Math.max(0, Number(item.w || 0));
    if (!Number.isFinite(x) || x < 0) return maxX;
    return Math.max(maxX, x + Math.min(w, commercialV2LoopSeamMargin));
  }, 1);
  return normalizeSegmentCount(Math.ceil(Math.max(1, rightmostAnchor) / commercialV2SegmentSize.width));
}

function clampBox(box, stageSize = getCommercialV2StageSize()) {
  const w = Math.max(8, Math.round(Number(box.w || 80)));
  const h = Math.max(8, Math.round(Number(box.h || 80)));
  return {
    ...box,
    x: Math.round(Math.max(-w + commercialV2LoopSeamMargin, Math.min(stageSize.width - commercialV2LoopSeamMargin, Number(box.x || 0)))),
    y: Math.round(Math.max(-h + commercialV2LoopSeamMargin, Math.min(stageSize.height - commercialV2LoopSeamMargin, Number(box.y || 0)))),
    w,
    h
  };
}

function wrapLoopBox(box, stageSize = getCommercialV2StageSize()) {
  const w = Math.max(8, Math.round(Number(box.w || 80)));
  const minX = -w + commercialV2LoopSeamMargin;
  const maxX = stageSize.width - commercialV2LoopSeamMargin;
  let x = Number(box.x || 0);
  if (Number.isFinite(x) && stageSize.width > 0) {
    while (x < minX) x += stageSize.width;
    while (x > maxX) x -= stageSize.width;
  }
  return clampBox({ ...box, x }, stageSize);
}

function wrapLoopCoordinate(value, width) {
  if (!Number.isFinite(value) || width <= 0) return 0;
  return ((value % width) + width) % width;
}

function getCommercialV2LoopDeltaX(fromX, toX, width) {
  if (!Number.isFinite(fromX) || !Number.isFinite(toX) || width <= 0) return 0;
  let delta = toX - fromX;
  if (delta > width / 2) delta -= width;
  if (delta < -width / 2) delta += width;
  return delta;
}

function isCommercialV2WalkableAsset(assetId) {
  return String(assetId || '').startsWith('road_');
}

function isCommercialV2MainRoadAsset(assetId) {
  const id = String(assetId || '');
  return id.startsWith('road_road_strip')
    || id.startsWith('road_road_lane')
    || id.startsWith('road_road_tile')
    || id.startsWith('road_road_intersection')
    || id.startsWith('road_road_t_junction')
    || id.startsWith('road_road_corner')
    || id.startsWith('road_road_curve')
    || id === 'road_extra_41'
    || id === 'road_asphalt_patch'
    || id === 'road_cracked_asphalt_patch';
}

function isCommercialV2StreetCruiseRoadAsset(assetId) {
  const id = String(assetId || '');
  return id.startsWith('road_road_strip')
    || id.startsWith('road_road_lane')
    || id.startsWith('road_road_tile')
    || id.startsWith('road_road_intersection')
    || id.startsWith('road_road_t_junction')
    || id.startsWith('road_road_corner')
    || id.startsWith('road_road_curve')
    || id === 'road_asphalt_patch'
    || id === 'road_cracked_asphalt_patch';
}

function isCommercialV2GroundLayerAsset(asset) {
  return asset?.type === '天空' || asset?.type === '道路';
}

function isCommercialV2GroundLayerItem(item, asset) {
  return Boolean(item?.groundLayer) || isCommercialV2GroundLayerAsset(asset);
}

function isCommercialV2DynamicOcclusionItem(item, asset) {
  return Boolean(item && asset) && !isCommercialV2GroundLayerItem(item, asset);
}

function canCommercialV2ItemCollisionTakeEffect(item, asset) {
  return Boolean(item && asset) && !isCommercialV2GroundLayerItem(item, asset);
}

function getCommercialV2PlaceLink(asset) {
  if (!asset || isCommercialV2GroundLayerAsset(asset)) return null;
  return commercialV2PlaceLinkByAssetId[asset.id] || null;
}

function getCommercialV2PlaceLocationIds(placeLink) {
  if (!placeLink) return [];
  const ids = Array.isArray(placeLink.locationIds)
    ? placeLink.locationIds
    : [placeLink.locationId || placeLink.placeId];
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}

function normalizeCommercialV2PlaceAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const x = Number(anchor.x);
  const y = Number(anchor.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: roundCommercialV2Ratio(x),
    y: roundCommercialV2Ratio(y)
  };
}

function buildCommercialV2ItemPlace(item, asset) {
  const placeLink = getCommercialV2PlaceLink(asset);
  if (!placeLink) return null;
  const manualAnchor = normalizeCommercialV2PlaceAnchor(item.placeAnchor);
  const anchor = manualAnchor || placeLink.anchor || { x: 0.5, y: 1 };
  const anchorRatio = {
    x: roundCommercialV2Ratio(Number(anchor.x)),
    y: roundCommercialV2Ratio(Number(anchor.y))
  };
  const anchorPoint = {
    x: Math.round(item.x + item.w * anchorRatio.x),
    y: Math.round(item.y + item.h * anchorRatio.y)
  };
  return {
    id: `${placeLink.placeId}:${item.id}`,
    placeId: placeLink.placeId,
    locationId: placeLink.locationId || placeLink.placeId,
    locationIds: getCommercialV2PlaceLocationIds(placeLink),
    name: placeLink.label || asset.name,
    kind: placeLink.kind || asset.type,
    itemId: item.id,
    assetId: item.assetId,
    anchor: anchorPoint,
    anchorRatio,
    manualAnchor: Boolean(manualAnchor),
    facing: placeLink.facing || 'front',
    actions: placeLink.actions || [],
    aliases: placeLink.aliases || []
  };
}

function buildCommercialV2Places(items, assetById) {
  return items
    .map((item) => buildCommercialV2ItemPlace(item, assetById.get(item.assetId)))
    .filter(Boolean);
}

function getCommercialV2PlaceAnchorLocalPoint(item, asset) {
  const place = buildCommercialV2ItemPlace(item, asset);
  if (!place) return null;
  return {
    x: Math.round(place.anchor.x - item.x),
    y: Math.round(place.anchor.y - item.y)
  };
}

function buildCommercialV2TravelTargetOptions(places) {
  const optionMap = new Map();
  const usedLabels = new Set();
  places.forEach((place) => {
    [place.placeId, ...place.locationIds].forEach((id) => {
      const targetId = String(id || '').trim();
      if (!targetId || optionMap.has(targetId)) return;
      const label = commercialV2TravelLabelById[targetId] || place.name || targetId;
      if (usedLabels.has(label)) return;
      usedLabels.add(label);
      optionMap.set(targetId, {
        id: targetId,
        label
      });
    });
  });
  return Array.from(optionMap.values()).sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

function getCommercialV2TravelAction(place, targetId) {
  if (!place) return '到达';
  if (targetId === 'street') return '闲逛中';
  if (targetId === 'park') return '散步中';
  if (targetId === 'factory') return '打工中';
  if (targetId === 'school') return '学习中';
  if (targetId === 'hospital') return '治疗中';
  if (targetId === 'convenience') return '购物中';
  if (targetId === 'restaurant') return '吃饭中';
  if (targetId === 'casino') return '试试运气中';
  if (targetId === 'home' || targetId === 'home_exit') return '回家中';
  if (targetId === 'agency' || place.kind === 'housing') return '咨询房源中';
  return place.actions?.[0] ? `${place.actions[0]}中` : '互动中';
}

function pushCommercialV2PathHeap(heap, node) {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (heap[parentIndex].priority <= node.priority) break;
    heap[index] = heap[parentIndex];
    index = parentIndex;
  }
  heap[index] = node;
}

function popCommercialV2PathHeap(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      if (leftIndex >= heap.length) break;
      const childIndex = rightIndex < heap.length && heap[rightIndex].priority < heap[leftIndex].priority
        ? rightIndex
        : leftIndex;
      if (heap[childIndex].priority >= last.priority) break;
      heap[index] = heap[childIndex];
      index = childIndex;
    }
    heap[index] = last;
  }
  return first;
}

function isCommercialV2CollisionAsset(asset) {
  return Boolean(asset);
}

function roundCommercialV2Ratio(value) {
  return Number(value.toFixed(3));
}

function isSameCommercialV2Collision(a, b) {
  if (!a || !b) return false;
  return ['x', 'y', 'w', 'h'].every((key) => Math.abs(Number(a[key]) - Number(b[key])) < 0.001);
}

function migrateCommercialV2Collision(collision, asset) {
  if (!collision || typeof collision !== 'object' || !asset) return collision;
  const legacyList = commercialV2LegacyCollisionByAssetId[asset.id];
  const legacyMatches = Array.isArray(legacyList)
    ? legacyList.some((legacy) => isSameCommercialV2Collision(collision, legacy))
    : isSameCommercialV2Collision(collision, legacyList);
  if (!legacyMatches) return collision;
  return {
    ...collision,
    ...commercialV2CollisionByAssetId[asset.id]
  };
}

function getCommercialV2DefaultCollision(asset) {
  if (!asset) {
    return { enabled: false, x: 0, y: 0, w: 1, h: 1 };
  }
  if (asset.type === '天空') return { enabled: false, x: 0, y: 0, w: 1, h: 1 };
  if (asset.type === '道路') return { enabled: false, x: 0, y: 0, w: 1, h: 1 };
  const typeDefault = commercialV2CollisionByType[asset.type] || commercialV2CollisionByType.街道;
  let specific = commercialV2CollisionByAssetId[asset.id];
  if (!specific && asset.id.startsWith('greenery_tree_')) {
    specific = { x: 0.34, y: 0.76, w: 0.32, h: 0.2 };
  } else if (!specific && asset.id.startsWith('greenery_grass_')) {
    specific = { x: 0.08, y: 0.54, w: 0.84, h: 0.38 };
  } else if (!specific && asset.id.startsWith('greenery_bush_')) {
    specific = { x: 0.08, y: 0.62, w: 0.84, h: 0.32 };
  } else if (!specific && asset.id.startsWith('greenery_hedge_')) {
    specific = { x: 0.06, y: 0.58, w: 0.88, h: 0.34 };
  } else if (!specific && asset.id.startsWith('greenery_cypress_')) {
    specific = { x: 0.34, y: 0.76, w: 0.32, h: 0.2 };
  } else if (!specific && asset.id.startsWith('prop_simple_')) {
    specific = { x: 0.08, y: 0.68, w: 0.84, h: 0.26 };
  }
  return { enabled: true, ...typeDefault, ...specific };
}

function normalizeCommercialV2Collision(collision, asset) {
  const defaults = getCommercialV2DefaultCollision(asset);
  const source = collision && typeof collision === 'object'
    ? { ...defaults, ...collision }
    : defaults;
  const enabled = Boolean(asset) && source.enabled !== false;
  const sourceX = Number(source.x);
  const sourceY = Number(source.y);
  const sourceW = Number(source.w);
  const sourceH = Number(source.h);
  const x = Number.isFinite(sourceX) ? sourceX : defaults.x;
  const y = Number.isFinite(sourceY) ? sourceY : defaults.y;
  const w = Math.max(0.02, Number.isFinite(sourceW) ? sourceW : defaults.w);
  const h = Math.max(0.02, Number.isFinite(sourceH) ? sourceH : defaults.h);
  return {
    enabled,
    x: roundCommercialV2Ratio(x),
    y: roundCommercialV2Ratio(y),
    w: roundCommercialV2Ratio(w),
    h: roundCommercialV2Ratio(h)
  };
}

function getCommercialV2EffectiveCollision(item, asset) {
  const collision = normalizeCommercialV2Collision(item?.collision, asset);
  if (!canCommercialV2ItemCollisionTakeEffect(item, asset)) {
    return { ...collision, enabled: false };
  }
  return collision;
}

function getCommercialV2CollisionLocalBox(item, asset) {
  const collision = getCommercialV2EffectiveCollision(item, asset);
  return {
    enabled: collision.enabled,
    x: Math.round(collision.x * item.w),
    y: Math.round(collision.y * item.h),
    w: Math.round(collision.w * item.w),
    h: Math.round(collision.h * item.h)
  };
}

function getCommercialV2CollisionWorldBox(item, asset) {
  const collision = getCommercialV2EffectiveCollision(item, asset);
  if (!collision.enabled) return null;
  return {
    x: item.x + collision.x * item.w,
    y: item.y + collision.y * item.h,
    w: collision.w * item.w,
    h: collision.h * item.h
  };
}

function getCommercialV2AutoRouteBlockWorldBox(item, asset) {
  if (!canCommercialV2ItemCollisionTakeEffect(item, asset)) return null;
  return getCommercialV2CollisionWorldBox(item, asset);
}

function getCommercialV2PlaceApproachMinY(place) {
  if (!place || !String(place.assetId || '').startsWith('building_')) return null;
  return place.anchor.y - 4;
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

function buildCommercialV2Silhouette(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const columns = Array.from({ length: commercialV2SilhouetteColumnCount }, () => ({
    top: 1,
    bottom: 0,
    filled: false
  }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= commercialV2SilhouetteAlphaThreshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const columnIndex = Math.min(
        commercialV2SilhouetteColumnCount - 1,
        Math.floor((x / width) * commercialV2SilhouetteColumnCount)
      );
      const column = columns[columnIndex];
      column.filled = true;
      column.top = Math.min(column.top, y / height);
      column.bottom = Math.max(column.bottom, (y + 1) / height);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return {
    bounds: {
      x: minX / width,
      y: minY / height,
      w: (maxX - minX + 1) / width,
      h: (maxY - minY + 1) / height
    },
    columns
  };
}

function loadCommercialV2AssetSilhouette(asset) {
  if (!asset || isCommercialV2GroundLayerAsset(asset)) return Promise.resolve(null);
  if (commercialV2SilhouetteCache.has(asset.id)) return commercialV2SilhouetteCache.get(asset.id);
  const promise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        resolve({
          assetId: asset.id,
          silhouette: buildCommercialV2Silhouette(image)
        });
      } catch {
        resolve({
          assetId: asset.id,
          silhouette: null
        });
      }
    };
    image.onerror = () => resolve({
      assetId: asset.id,
      silhouette: null
    });
    image.src = commercialV2Asset(asset.path);
  });
  commercialV2SilhouetteCache.set(asset.id, promise);
  return promise;
}

function getCommercialV2DepthY(asset) {
  if (!asset) return 1;
  if (commercialV2DepthYByAssetId[asset.id] !== undefined) return commercialV2DepthYByAssetId[asset.id];
  if (asset.id.startsWith('greenery_tree_')) return 0.98;
  if (asset.id.startsWith('greenery_')) return 0.94;
  if (asset.id.startsWith('building_')) return 0.92;
  return commercialV2DepthYByType[asset.type] ?? 0.94;
}

function getCommercialV2SortY(item, asset) {
  return item.y + item.h * getCommercialV2DepthY(asset);
}

function getCommercialV2ItemRenderZIndex(layerIndex, item, asset) {
  if (asset && isCommercialV2GroundLayerItem(item, asset)) {
    return commercialV2GroundLayerZIndex + layerIndex;
  }
  return getCommercialV2ItemZIndex(layerIndex);
}

function getCommercialV2PlayerRenderZIndex(player, tie = 0) {
  return getCommercialV2DepthZIndex(player?.y ?? commercialV2PlayerInitial.y, 500 + tie);
}

function getCommercialV2OcclusionBox(item, asset, silhouette = null) {
  if (!asset || isCommercialV2GroundLayerAsset(asset)) return null;
  const sortYRatio = commercialV2OcclusionSortYRatioByAssetId[asset.id];
  if (silhouette?.bounds) {
    const { bounds } = silhouette;
    return {
      x: item.x + bounds.x * item.w,
      y: item.y + bounds.y * item.h,
      w: bounds.w * item.w,
      h: bounds.h * item.h,
      sortY: item.y + (Number.isFinite(sortYRatio) ? sortYRatio : bounds.y + bounds.h) * item.h,
      silhouette
    };
  }
  const fallbackTop = item.y + item.h * Math.max(0, getCommercialV2DepthY(asset) - 0.18);
  return {
    x: item.x,
    y: fallbackTop,
    w: item.w,
    h: Math.max(1, item.y + item.h - fallbackTop),
    sortY: Number.isFinite(sortYRatio) ? item.y + sortYRatio * item.h : getCommercialV2SortY(item, asset)
  };
}

function getCommercialV2OcclusionLayer(occlusionBox, playerFootY) {
  return occlusionBox.sortY > playerFootY + commercialV2OcclusionDepthMargin ? 'front' : 'back';
}

function getCommercialV2ColumnOcclusionBottom(asset, column, columnIndex, columnCount) {
  const rightCornerCap = commercialV2OcclusionRightCornerCapByAssetId[asset.id];
  if (!rightCornerCap) return column.bottom;
  const columnCenterX = (columnIndex + 0.5) / columnCount;
  if (columnCenterX < rightCornerCap.startX || column.bottom <= rightCornerCap.maxBottom) return column.bottom;
  return rightCornerCap.maxBottom;
}

function isCommercialV2AlwaysBackLowerBody(item, asset, playerBox, itemOffset = 0) {
  if (!commercialV2AlwaysBackLowerBodyAssetIds.has(asset.id)) return false;
  const lowerBodyHeight = Math.min(item.h, Math.max(1, playerBox.h));
  return boxesOverlap(playerBox, {
    x: item.x + itemOffset,
    y: item.y + item.h - lowerBodyHeight,
    w: item.w,
    h: lowerBodyHeight
  });
}

function getCommercialV2OcclusionDecision(item, asset, silhouette, playerBox, playerFootY, itemOffset = 0) {
  const occlusionBox = getCommercialV2OcclusionBox(item, asset, silhouette);
  if (!occlusionBox) return null;
  const shiftedBox = {
    x: occlusionBox.x + itemOffset,
    y: occlusionBox.y,
    w: occlusionBox.w,
    h: occlusionBox.h
  };
  if (!boxesOverlap(playerBox, shiftedBox)) return null;
  if (isCommercialV2AlwaysBackLowerBody(item, asset, playerBox, itemOffset)) return 'back';
  if (!silhouette?.columns?.length || !item.w || !item.h) {
    return getCommercialV2OcclusionLayer(occlusionBox, playerFootY);
  }
  const itemLeft = item.x + itemOffset;
  const itemRight = itemLeft + item.w;
  const overlapLeft = Math.max(playerBox.x, itemLeft);
  const overlapRight = Math.min(playerBox.x + playerBox.w, itemRight);
  if (overlapRight <= overlapLeft) return null;
  const columnCount = silhouette.columns.length;
  const startColumn = Math.max(0, Math.floor(((overlapLeft - itemLeft) / item.w) * columnCount));
  const endColumn = Math.min(columnCount - 1, Math.floor(((overlapRight - itemLeft) / item.w) * columnCount));
  let deepestSilhouetteBottom = -Infinity;
  for (let columnIndex = startColumn; columnIndex <= endColumn; columnIndex += 1) {
    const column = silhouette.columns[columnIndex];
    if (!column?.filled) continue;
    const worldTop = item.y + column.top * item.h;
    const columnBottom = getCommercialV2ColumnOcclusionBottom(asset, column, columnIndex, columnCount);
    const worldBottom = item.y + columnBottom * item.h;
    if (playerBox.y >= worldBottom || playerBox.y + playerBox.h <= worldTop) continue;
    deepestSilhouetteBottom = Math.max(deepestSilhouetteBottom, worldBottom);
  }
  if (!Number.isFinite(deepestSilhouetteBottom)) return null;
  const usesExplicitSortY = Number.isFinite(commercialV2OcclusionSortYRatioByAssetId[asset.id]);
  return getCommercialV2OcclusionLayer({
    ...occlusionBox,
    sortY: usesExplicitSortY ? occlusionBox.sortY : deepestSilhouetteBottom
  }, playerFootY);
}

function serializeCommercialV2Item(item, asset) {
  const next = {
    assetId: item.assetId,
    id: item.id,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h
  };
  if (item.groundLayer === true) {
    next.groundLayer = true;
  }
  const collision = normalizeCommercialV2Collision(item.collision, asset);
  const hasManualCollision = item.collision && typeof item.collision === 'object';
  if (collision.enabled || hasManualCollision || (asset && !isCommercialV2GroundLayerAsset(asset))) {
    next.collision = collision;
  }
  const placeAnchor = normalizeCommercialV2PlaceAnchor(item.placeAnchor);
  if (placeAnchor) {
    next.placeAnchor = placeAnchor;
  }
  return next;
}

function isCommercialV2SkyStripAsset(asset) {
  return asset?.id?.startsWith('sky_sky_');
}

function normalizeCommercialV2ItemAspect(box, asset) {
  const fixedRatio = commercialV2AspectRatioByAssetId[asset?.id];
  if (Number.isFinite(fixedRatio)) {
    const rawX = Number(box.x);
    const rawW = Number(box.w || asset?.box?.w || 80);
    const rawH = Number(box.h || asset?.box?.h || 80);
    const h = Math.max(8, Math.round(Number.isFinite(rawH) ? rawH : 80));
    const currentW = Math.max(8, Math.round(Number.isFinite(rawW) ? rawW : h * fixedRatio));
    const currentRatio = currentW / h;
    if (Math.abs(currentRatio - fixedRatio) > 0.08) {
      const w = Math.max(8, Math.round(h * fixedRatio));
      return {
        ...box,
        x: Number.isFinite(rawX) ? Math.round(rawX - (w - currentW) / 2) : box.x,
        w,
        h
      };
    }
  }
  if (!isCommercialV2SkyStripAsset(asset) || !asset?.naturalWidth || !asset?.naturalHeight) return box;
  const w = Math.max(8, Math.round(Number(box.w || asset.box?.w || 80)));
  const h = Math.max(8, Math.round(w * (asset.naturalHeight / asset.naturalWidth)));
  return { ...box, w, h };
}

function getLayoutBounds(items) {
  if (!items.length) return null;
  return items.reduce((bounds, item) => ({
    minX: Math.min(bounds.minX, item.x),
    minY: Math.min(bounds.minY, item.y),
    maxX: Math.max(bounds.maxX, item.x + item.w),
    maxY: Math.max(bounds.maxY, item.y + item.h)
  }), {
    minX: items[0].x,
    minY: items[0].y,
    maxX: items[0].x + items[0].w,
    maxY: items[0].y + items[0].h
  });
}

function getPointerStagePoint(event, stage, stageSize) {
  const rect = stage.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * stageSize.width,
    y: ((event.clientY - rect.top) / rect.height) * stageSize.height
  };
}

function CommercialStreetEditor({ apiUrl = '/api', userProfile = null }) {
  const stageRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const loopScrollGuardRef = useRef(false);
  const pendingLoopScrollRef = useRef('middle');
  const dragRef = useRef(null);
  const dragFrameRef = useRef(null);
  const pendingDragPointRef = useRef(null);
  const pressedKeysRef = useRef(new Set());
  const playersRef = useRef(createCommercialV2PlayerStates());
  const controlledPlayerIdRef = useRef(commercialV2DefaultControlledPlayerId);
  const playerRef = useRef(playersRef.current[commercialV2DefaultControlledPlayerId]);
  const playerSpawnedRef = useRef(false);
  const autoTravelRef = useRef(null);
  const behaviorRuntimeRef = useRef(null);
  const behaviorChoicePendingRef = useRef(false);
  const behaviorTreeStateRef = useRef(null);
  const autonomousBehaviorCooldownRef = useRef(Date.now() + commercialV2BehaviorAutonomousInitialDelayMs);
  const autonomousBehaviorCursorRef = useRef(0);
  const autonomousBehaviorRecentRef = useRef([]);
  const pickAutonomousBehaviorBranchRef = useRef(() => null);
  const activateBehaviorBranchRef = useRef(() => {});
  const advanceBehaviorRuntimeRef = useRef(() => {});
  const [initialLayout] = useState(() => readStoredCommercialLayout());
  const [items, setItemsState] = useState(initialLayout.items);
  const itemsRef = useRef(initialLayout.items);
  const [segmentCount, setSegmentCountState] = useState(initialLayout.segmentCount);
  const segmentCountRef = useRef(initialLayout.segmentCount);
  const [resetBackup, setResetBackup] = useState(() => readStoredCommercialResetBackup());
  const [selectedId, setSelectedId] = useState('');
  const [zoom, setZoom] = useState(commercialV2DefaultZoom);
  const [viewMode, setViewMode] = useState(true);
  const [groupEditMode, setGroupEditMode] = useState(false);
  const [showCollisionLines, setShowCollisionLines] = useState(false);
  const [showPlaceAnchors, setShowPlaceAnchors] = useState(false);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const [activeAssetType, setActiveAssetType] = useState('建筑');
  const [autoTargetId, setAutoTargetId] = useState('');
  const [autoTravelActive, setAutoTravelActive] = useState(false);
  const [notice, setNotice] = useState('观赏模式已开启：素材已锁定，可以安心浏览和控制小人。');
  const [controlledPlayerId, setControlledPlayerId] = useState(commercialV2DefaultControlledPlayerId);
  const [players, setPlayers] = useState(() => createCommercialV2PlayerStates());
  const [playerScale, setPlayerScale] = useState(commercialV2DefaultPlayerScale);
  const [playerActionBubble, setPlayerActionBubble] = useState('');
  const [playerActionBubbles, setPlayerActionBubbles] = useState({});
  const [activeBehaviorDialog, setActiveBehaviorDialog] = useState(null);
  const [interactionMenuOpen, setInteractionMenuOpen] = useState(false);
  const [assetSilhouettes, setAssetSilhouettes] = useState({});
  const [behaviorCharacters, setBehaviorCharacters] = useState([]);
  const [behaviorCharacterId, setBehaviorCharacterId] = useState('');
  const [behaviorAction, setBehaviorAction] = useState('greet');
  const [behaviorPlaceId, setBehaviorPlaceId] = useState('');
  const [behaviorPromptText, setBehaviorPromptText] = useState('');
  const [behaviorConfig, setBehaviorConfig] = useState(() => readStoredCommercialBehaviorConfig());
  const [behaviorModelOptions, setBehaviorModelOptions] = useState([]);
  const [behaviorInput, setBehaviorInput] = useState(null);
  const [behaviorOutput, setBehaviorOutput] = useState(null);
  const [behaviorTreeState, setBehaviorTreeState] = useState(() => readStoredCommercialBehaviorTreeState());
  const [behaviorPatchOutput, setBehaviorPatchOutput] = useState(null);
  const [activeBehaviorBranch, setActiveBehaviorBranch] = useState(null);
  const [behaviorStatus, setBehaviorStatus] = useState('等待读取大输入背景。');
  const [behaviorModelStatus, setBehaviorModelStatus] = useState('默认使用绑定角色的模型配置；需要覆盖时再填写 URL 和 Key。');
  const [behaviorLoading, setBehaviorLoading] = useState(false);
  const [behaviorModelsLoading, setBehaviorModelsLoading] = useState(false);
  const [behaviorShowKey, setBehaviorShowKey] = useState(false);
  const [behaviorPanelCollapsed, setBehaviorPanelCollapsed] = useState(true);
  const [behaviorFoldOpen, setBehaviorFoldOpen] = useState({
    model: false,
    constraints: false,
    branchMap: false,
    interaction: false,
    runtime: true,
    debug: false
  });
  const stageSize = useMemo(() => getCommercialV2StageSize(segmentCount, items), [items, segmentCount]);
  const assetById = useMemo(() => new Map(commercialV2AssetCatalog.map((asset) => [asset.id, asset])), []);
  const walkableRects = useMemo(() => items
    .filter((item) => isCommercialV2WalkableAsset(item.assetId))
    .map((item) => ({
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    })), [items]);
  const mainRoadRects = useMemo(() => items
    .filter((item) => isCommercialV2MainRoadAsset(item.assetId))
    .map((item) => ({
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    })), [items]);
  const streetCruiseRoadRects = useMemo(() => items
    .filter((item) => isCommercialV2StreetCruiseRoadAsset(item.assetId))
    .map((item) => ({
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    })), [items]);
  const collisionRects = useMemo(() => items
    .map((item) => {
      const asset = assetById.get(item.assetId);
      const collisionBox = getCommercialV2CollisionWorldBox(item, asset);
      if (!collisionBox) return null;
      return {
        id: item.id,
        ...collisionBox
      };
    })
    .filter(Boolean), [assetById, items]);
  const autoRouteBlockRects = useMemo(() => items
    .map((item) => {
      const asset = assetById.get(item.assetId);
      const routeBlockBox = getCommercialV2AutoRouteBlockWorldBox(item, asset);
      if (!routeBlockBox) return null;
      return {
        id: item.id,
        ...routeBlockBox
      };
    })
    .filter(Boolean), [assetById, items]);
  const placeLinks = useMemo(() => buildCommercialV2Places(items, assetById), [assetById, items]);
  const travelTargetOptions = useMemo(() => buildCommercialV2TravelTargetOptions(placeLinks), [placeLinks]);
  const behaviorOrderedPlaces = useMemo(() => placeLinks
    .filter((place) => commercialV2BehaviorImportantPlaceIds.has(place.placeId))
    .slice()
    .sort((a, b) => (a.anchor?.x || 0) - (b.anchor?.x || 0))
    .map((place, index) => ({
      ...place,
      order: index + 1
    })), [placeLinks]);
  const behaviorPlaceOptions = useMemo(() => {
    const importantOptions = behaviorOrderedPlaces.map((place) => ({
      id: place.placeId,
      label: place.name,
      order: place.order
    }));
    return importantOptions.length ? importantOptions : travelTargetOptions;
  }, [behaviorOrderedPlaces, travelTargetOptions]);
  const silhouetteAssetIds = useMemo(() => Array.from(new Set(items
    .filter((item) => isCommercialV2DynamicOcclusionItem(item, assetById.get(item.assetId)))
    .map((item) => item.assetId))), [assetById, items]);
  const playerDimensions = useMemo(() => ({
    width: commercialV2PlayerSize.width * playerScale,
    height: commercialV2PlayerSize.height * playerScale,
    footOffset: commercialV2PlayerSize.footOffset * playerScale
  }), [playerScale]);
  const selectedItem = items.find((item) => item.id === selectedId) || null;
  const selectedAsset = selectedItem ? assetById.get(selectedItem.assetId) : null;
  const selectedCollisionCanTakeEffect = Boolean(
    selectedItem && selectedAsset && canCommercialV2ItemCollisionTakeEffect(selectedItem, selectedAsset)
  );
  const selectedCollision = selectedItem && selectedAsset
    ? getCommercialV2EffectiveCollision(selectedItem, selectedAsset)
    : null;
  const selectedCollisionLocalBox = selectedItem && selectedAsset
    ? getCommercialV2CollisionLocalBox(selectedItem, selectedAsset)
    : null;
  const selectedPlace = selectedItem && selectedAsset
    ? buildCommercialV2ItemPlace(selectedItem, selectedAsset)
    : null;
  const selectedPlaceAnchorLocalPoint = selectedItem && selectedAsset
    ? getCommercialV2PlaceAnchorLocalPoint(selectedItem, selectedAsset)
    : null;
  const selectedIsBuiltInGroundLayer = Boolean(selectedAsset && isCommercialV2GroundLayerAsset(selectedAsset));
  const selectedIsGroundLayer = Boolean(selectedItem && selectedAsset && isCommercialV2GroundLayerItem(selectedItem, selectedAsset));
  const layerRows = useMemo(() => items.map((item, layerIndex) => {
    const asset = assetById.get(item.assetId);
    const isGround = Boolean(asset && isCommercialV2GroundLayerItem(item, asset));
    return {
      item,
      asset,
      layerIndex,
      zIndex: getCommercialV2ItemRenderZIndex(layerIndex, item, asset),
      isGround,
      playerRule: isGround ? '恒在人物下方 / 忽略碰撞' : '按图层顺序 / 遮挡判断'
    };
  }), [assetById, items]);
  const selectedLayerRow = selectedId
    ? layerRows.find((row) => row.item.id === selectedId) || null
    : null;
  const layoutBounds = useMemo(() => getLayoutBounds(items), [items]);
  const groupedAssets = useMemo(() => {
    const groups = new Map();
    commercialV2AssetCatalog.forEach((asset) => {
      if (!groups.has(asset.type)) groups.set(asset.type, []);
      groups.get(asset.type).push(asset);
    });
    return Array.from(groups.entries());
  }, []);
  const activeAssetGroup = groupedAssets.find(([type]) => type === activeAssetType) || groupedAssets[0];
  const canEditLayout = !viewMode;
  const player = players[controlledPlayerId]
    || players[commercialV2DefaultControlledPlayerId]
    || createCommercialV2PlayerState(commercialV2PlayerCharacters[0]);
  const roleActor = players[commercialV2RoleActorId]
    || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2RoleActorId) || commercialV2PlayerCharacters[0]);
  const userActor = players[commercialV2UserActorId]
    || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2UserActorId) || commercialV2PlayerCharacters[0]);
  const controlledPlayerCharacter = getCommercialV2PlayerCharacter(player);
  const behaviorCharacter = behaviorCharacters.find((item) => item.id === behaviorCharacterId) || behaviorCharacters[0] || null;
  const behaviorPrimaryActions = commercialV2BehaviorPrimaryActionIds
    .map((id) => commercialV2BehaviorActions.find((item) => item.id === id))
    .filter(Boolean);
  const behaviorContextActions = commercialV2BehaviorContextActionIds
    .map((id) => commercialV2BehaviorActions.find((item) => item.id === id))
    .filter(Boolean);
  const behaviorInteractionState = useMemo(() => {
    const dx = getCommercialV2LoopDeltaX(roleActor.x, userActor.x, stageSize.width);
    const dy = userActor.y - roleActor.y;
    const distance = Math.hypot(dx, dy);
    let side = dx >= 0 ? 'left' : 'right';
    if (roleActor.x < 320) side = 'right';
    if (roleActor.x > stageSize.width - 320) side = 'left';
    const bodyY = roleActor.y - playerDimensions.height * 0.42 + playerDimensions.footOffset;
    const menuY = Math.max(96, Math.min(stageSize.height - 90, bodyY));
    return {
      distance,
      nearby: distance <= commercialV2BehaviorInteractionDistance,
      x: wrapLoopCoordinate(roleActor.x, stageSize.width),
      y: menuY,
      side
    };
  }, [playerDimensions.footOffset, playerDimensions.height, roleActor.x, roleActor.y, stageSize.height, stageSize.width, userActor.x, userActor.y]);

  useEffect(() => {
    if (!behaviorInteractionState.nearby || activeBehaviorDialog) {
      setInteractionMenuOpen(false);
    }
  }, [activeBehaviorDialog, behaviorInteractionState.nearby]);

  const setPlayerById = useCallback((playerId, updater) => {
    const character = commercialV2PlayerCharacterById.get(playerId) || commercialV2PlayerCharacters[0];
    setPlayers((currentPlayers) => {
      const currentPlayer = currentPlayers[playerId] || createCommercialV2PlayerState(character);
      const nextPatch = typeof updater === 'function' ? updater(currentPlayer) : updater;
      const nextPlayer = {
        ...currentPlayer,
        ...nextPatch,
        id: playerId,
        characterId: currentPlayer.characterId || playerId
      };
      const nextPlayers = {
        ...currentPlayers,
        [playerId]: nextPlayer
      };
      playersRef.current = nextPlayers;
      if (playerId === controlledPlayerIdRef.current) playerRef.current = nextPlayer;
      return nextPlayers;
    });
  }, []);

  const setPlayer = useCallback((updater) => {
    setPlayerById(controlledPlayerIdRef.current, updater);
  }, [setPlayerById]);

  function setWorldPlayerBubble(playerId, text) {
    const safeText = String(text || '').trim().slice(0, 80);
    setPlayerActionBubbles((current) => {
      const next = { ...current };
      if (safeText) next[playerId] = safeText;
      else delete next[playerId];
      return next;
    });
    if (playerId === controlledPlayerIdRef.current) {
      setPlayerActionBubble(safeText);
    }
  }

  const commitItems = useCallback((updater) => {
    const previous = itemsRef.current;
    const next = typeof updater === 'function' ? updater(previous) : updater;
    itemsRef.current = next;
    setItemsState(next);
    return next;
  }, []);

  const commitSegmentCount = useCallback((updater) => {
    const previous = segmentCountRef.current;
    const next = typeof updater === 'function' ? updater(previous) : updater;
    segmentCountRef.current = next;
    setSegmentCountState(next);
    return next;
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    segmentCountRef.current = segmentCount;
  }, [segmentCount]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    controlledPlayerIdRef.current = controlledPlayerId;
  }, [controlledPlayerId]);

  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  useEffect(() => {
    if (!travelTargetOptions.length) {
      setAutoTargetId('');
      return;
    }
    if (autoTargetId && travelTargetOptions.some((option) => option.id === autoTargetId)) return;
    const preferredTarget = travelTargetOptions.find((option) => option.id === 'convenience')
      || travelTargetOptions.find((option) => option.id === 'restaurant')
      || travelTargetOptions[0];
    setAutoTargetId(preferredTarget.id);
  }, [autoTargetId, travelTargetOptions]);

  useEffect(() => {
    if (!behaviorPlaceOptions.length) {
      setBehaviorPlaceId('');
      return;
    }
    if (behaviorPlaceId && behaviorPlaceOptions.some((option) => option.id === behaviorPlaceId)) return;
    const preferredTarget = behaviorPlaceOptions.find((option) => option.id === 'restaurant')
      || behaviorPlaceOptions.find((option) => option.id === 'convenience')
      || behaviorPlaceOptions[0];
    setBehaviorPlaceId(preferredTarget.id);
  }, [behaviorPlaceId, behaviorPlaceOptions]);

  useEffect(() => {
    try {
      localStorage.setItem(commercialV2BehaviorConfigStorageKey, JSON.stringify({
        api_endpoint: behaviorConfig.api_endpoint || '',
        model_name: behaviorConfig.model_name || ''
      }));
    } catch {
      // Ignore storage failures; the API key is intentionally never persisted here.
    }
  }, [behaviorConfig.api_endpoint, behaviorConfig.model_name]);

  useEffect(() => {
    behaviorTreeStateRef.current = behaviorTreeState;
  }, [behaviorTreeState]);

  useEffect(() => {
    try {
      localStorage.setItem(commercialV2BehaviorTreeStorageKey, JSON.stringify(behaviorTreeState));
    } catch {
      // The tree can still live in memory if browser storage is full or unavailable.
    }
  }, [behaviorTreeState]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!behaviorCharacterId || !behaviorOrderedPlaces.length) return;
      if (behaviorLoading || activeBehaviorDialog || interactionMenuOpen) return;
      if (behaviorChoicePendingRef.current || behaviorRuntimeRef.current) return;
      if (Date.now() < autonomousBehaviorCooldownRef.current) return;
      const branch = pickAutonomousBehaviorBranchRef.current({ nearby: behaviorInteractionState.nearby });
      if (!branch) return;
      autonomousBehaviorCooldownRef.current = Date.now() + (behaviorInteractionState.nearby
        ? commercialV2BehaviorNearbyCooldownMs
        : commercialV2BehaviorAutonomousCooldownMs);
      activateBehaviorBranchRef.current(branch, 'base');
      setBehaviorStatus(`基础枝丫自动执行：${branch.title}`);
    }, 700);
    return () => window.clearInterval(intervalId);
  }, [
    activeBehaviorDialog,
    behaviorCharacterId,
    behaviorInteractionState.nearby,
    behaviorLoading,
    behaviorOrderedPlaces.length,
    behaviorTreeState.version,
    interactionMenuOpen
  ]);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('cp_token') || '';
    fetch(`${apiUrl}/city/characters`, {
      headers: { Authorization: token ? `Bearer ${token}` : '' }
    })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`角色列表读取失败 ${response.status}`)))
      .then((data) => {
        if (cancelled) return;
        const characters = Array.isArray(data?.characters) ? data.characters : [];
        setBehaviorCharacters(characters);
        setBehaviorCharacterId((current) => {
          if (current && characters.some((item) => item.id === current)) return current;
          const preferred = characters.find((item) => Number(item.sys_survival ?? 1) === 1) || characters[0];
          return preferred?.id || '';
        });
      })
      .catch((error) => {
        if (!cancelled) setBehaviorStatus(`角色列表读取失败：${error.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  useEffect(() => {
    const missingAssetIds = silhouetteAssetIds.filter((assetId) => assetSilhouettes[assetId] === undefined);
    if (!missingAssetIds.length) return undefined;
    let cancelled = false;
    Promise.all(missingAssetIds.map((assetId) => loadCommercialV2AssetSilhouette(assetById.get(assetId))))
      .then((results) => {
        if (cancelled) return;
        setAssetSilhouettes((current) => {
          const next = { ...current };
          results.forEach((result) => {
            if (!result) return;
            next[result.assetId] = result.silhouette;
          });
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [assetById, assetSilhouettes, silhouetteAssetIds]);

  function updatePlayerScale(value) {
    const next = Math.max(0.6, Math.min(3, Number(value) || commercialV2DefaultPlayerScale));
    setPlayerScale(Number(next.toFixed(2)));
  }

  function toggleCollisionLines() {
    setShowCollisionLines((enabled) => {
      const next = !enabled;
      setNotice(next ? '碰撞箱线已显示：绿色线是真实阻挡范围，黄色线是角色之间的脚底占位；地面层碰撞箱不参与阻挡。' : '碰撞箱线已隐藏，非地面层碰撞仍然默认生效。');
      return next;
    });
  }

  function togglePlaceAnchors() {
    setShowPlaceAnchors((enabled) => {
      const next = !enabled;
      setNotice(next ? '地点锚点已显示：粉色点是角色后续自动前往和交互的位置。' : '地点锚点已隐藏，地点联动数据仍会保留在布局 JSON。');
      return next;
    });
  }

  function focusCanvasForKeyboard() {
    const activeElement = document.activeElement;
    const activeTag = activeElement?.tagName?.toLowerCase();
    if (activeElement?.isContentEditable || activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
      activeElement.blur();
    }
    canvasWrapRef.current?.focus?.({ preventScroll: true });
  }

  function updateBehaviorConfig(patch) {
    setBehaviorConfig((current) => ({
      ...current,
      ...patch
    }));
  }

  function getBehaviorAuthHeaders() {
    const token = localStorage.getItem('cp_token') || '';
    return {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : ''
    };
  }

  async function fetchBehaviorJsonWithTimeout(url, options = {}, timeoutMs = 18000) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function formatBehaviorRequestError(error, fallback = '请求失败，请重试。') {
    if (error?.name === 'AbortError') return '请求超时，请重试。';
    return error?.message || fallback;
  }

  function resolveBehaviorAction(actionId = behaviorAction) {
    return commercialV2BehaviorActions.find((item) => item.id === actionId) || commercialV2BehaviorActions[0];
  }

  function resolveBehaviorPlace(placeId = behaviorPlaceId) {
    return behaviorPlaceOptions.find((option) => option.id === placeId)
      || behaviorPlaceOptions.find((option) => option.id === 'restaurant')
      || behaviorPlaceOptions[0]
      || null;
  }

  function resolveBehaviorPlaceLink(placeOption) {
    if (!placeOption) return null;
    const targetId = String(placeOption.id || '');
    return placeLinks.find((place) => (
      place.placeId === targetId || place.locationId === targetId || place.locationIds?.includes(targetId)
    )) || null;
  }

  function summarizeBehaviorActor(actorId, label) {
    const character = commercialV2PlayerCharacterById.get(actorId) || commercialV2PlayerCharacters[0];
    const actor = players[actorId] || createCommercialV2PlayerState(character);
    return {
      id: actorId,
      label,
      sprite: character.label,
      direction: actor.direction,
      moving: Boolean(actor.moving),
      controlled: actorId === controlledPlayerId,
      movement_mode: 'side_scrolling_semantic'
    };
  }

  function summarizeBehaviorPlace(place) {
    if (!place) return null;
    return {
      order: place.order || 0,
      id: place.placeId,
      location_id: place.locationId,
      location_ids: place.locationIds || [],
      label: place.name,
      kind: place.kind,
      actions: place.actions || [],
      aliases: place.aliases || []
    };
  }

  function summarizeBehaviorTreeForPayload() {
    const nodes = behaviorTreeState?.nodes || {};
    const compactNodes = {};
    const patchHistory = Array.isArray(behaviorTreeState?.patch_history) ? behaviorTreeState.patch_history : [];
    const prioritizedNodeIds = [
      behaviorTreeState?.active_node_id,
      ...(Array.isArray(nodes.player_interaction?.children_ids) ? nodes.player_interaction.children_ids : []),
      ...patchHistory.slice(0, 12).map((item) => item?.node_id || item?.nodeId || item?.next_active_node_id || item?.nextActiveNodeId)
    ].map((id) => String(id || '').trim()).filter(Boolean);
    const orderedEntries = [];
    const seenNodeIds = new Set();
    function pushBehaviorNode(id) {
      if (!id || seenNodeIds.has(id) || !nodes[id]) return;
      seenNodeIds.add(id);
      orderedEntries.push([id, nodes[id]]);
    }
    prioritizedNodeIds.forEach(pushBehaviorNode);
    Object.keys(nodes).forEach(pushBehaviorNode);
    orderedEntries.slice(0, 60).forEach(([id, node]) => {
      compactNodes[id] = {
        id: node.id || id,
        type: node.type || 'Node',
        title: node.title || '',
        priority: node.priority,
        trigger: node.trigger,
        children_ids: Array.isArray(node.children_ids) ? node.children_ids.slice(0, 12) : [],
        summary: node.summary || '',
        steps: Array.isArray(node.steps) ? node.steps.slice(0, 10) : undefined,
        branch_kind: node.branch_kind || node.branchKind || '',
        source: node.source || ''
      };
    });
    return {
      tree_id: behaviorTreeState?.tree_id || 'street_runtime_single_character',
      schema: behaviorTreeState?.schema || 'full_behavior_tree_patch_v1',
      version: behaviorTreeState?.version || 1,
      root_id: behaviorTreeState?.root_id || 'street_character_root',
      active_node_id: behaviorTreeState?.active_node_id || '',
      nodes: compactNodes,
      memory: behaviorTreeState?.memory || {},
      patch_history: patchHistory.slice(0, 8)
    };
  }

  function buildBehaviorPayload(options = {}) {
    const selectedAction = resolveBehaviorAction(options.actionId || behaviorAction);
    const selectedPlace = resolveBehaviorPlace(options.placeId || behaviorPlaceId);
    const selectedPlaceLink = resolveBehaviorPlaceLink(selectedPlace);
    return {
      player_event: {
        active: true,
        action: selectedAction?.id || options.actionId || behaviorAction,
        action_label: selectedAction?.label || options.actionId || behaviorAction,
        action_hint: selectedAction?.hint || '',
        place_id: selectedPlace?.id || options.placeId || behaviorPlaceId || '',
        place_label: selectedPlace?.label || '',
        free_text: behaviorPromptText
      },
      world: {
        movement_model: 'side_scrolling_semantic_v1',
        movement_rule: '角色可以决定自由活动、靠近玩家、闲逛或去语义地点；不要生成像素坐标，前端会把 place_id 映射到本地平移锚点。',
        ordered_place_text: behaviorOrderedPlaces.map((place) => `${place.order}. ${place.name}`).join(' -> '),
        allowed_place_ids: behaviorOrderedPlaces.map((place) => place.placeId),
        allowed_movement_actions: commercialV2BehaviorMovementActions,
        actors: {
          role: summarizeBehaviorActor(commercialV2RoleActorId, '角色小人'),
          user: summarizeBehaviorActor(commercialV2UserActorId, '玩家小人')
        },
        selected_place: selectedPlace
          ? {
            id: selectedPlace.id,
            label: selectedPlace.label,
            place: summarizeBehaviorPlace(selectedPlaceLink)
          }
          : null,
        places_ordered: behaviorOrderedPlaces.map((place) => summarizeBehaviorPlace(place)).filter(Boolean),
        free_activity_options: [
          'go_to_place: 前往表内地点',
          'wander_between: 在两个表内地点之间来回闲逛',
          'loop_in_front_of: 在表内地点前小范围循环移动',
          'browse_near: 在表内地点附近停停走走',
          'patrol_segment: 在两个表内地点之间巡逻',
          'approach_player: 靠近玩家',
          'follow_player: 跟随玩家',
          'walk_with_player: 陪玩家向表内地点移动',
          'idle_at_place: 在表内地点附近停留'
        ]
      },
      behavior_tree: summarizeBehaviorTreeForPayload()
    };
  }

  function buildBehaviorPendingInput(options = {}, note = '当前前端请求；服务端会重新补齐 large_input。') {
    return {
      ...buildBehaviorPayload(options),
      debug_source: 'client_pending_behavior_request',
      debug_note: note
    };
  }

  function formatBehaviorJson(value, fallback = '{}') {
    try {
      return JSON.stringify(value || JSON.parse(fallback), null, 2);
    } catch {
      return fallback;
    }
  }

  async function pullBehaviorModels() {
    const customEndpoint = String(behaviorConfig.api_endpoint || '').trim();
    const customKey = String(behaviorConfig.api_key || '').trim();
    const customComplete = Boolean(customEndpoint && customKey);
    const customIncomplete = Boolean(customEndpoint || customKey) && !customComplete;
    if (customIncomplete && !behaviorCharacterId) {
      const message = '自定义模型配置需要同时填写 URL 和 Key；当前也没有可用绑定角色。';
      setBehaviorModelStatus(message);
      setBehaviorStatus(message);
      return;
    }
    if (!customComplete && !behaviorCharacterId) {
      const message = '没有绑定角色，无法使用角色模型配置。';
      setBehaviorModelStatus(message);
      setBehaviorStatus(message);
      return;
    }
    setBehaviorModelsLoading(true);
    const sourceLabel = customComplete ? '自定义配置' : '绑定角色配置';
    setBehaviorModelStatus(customIncomplete
      ? '自定义 URL/Key 未填完整，正在改用绑定角色配置拉取模型列表...'
      : `正在通过${sourceLabel}拉取模型列表...`);
    setBehaviorStatus('正在拉取模型列表...');
    try {
      const url = customComplete
        ? `${apiUrl}/models`
        : `${apiUrl}/city/characters/${encodeURIComponent(behaviorCharacterId)}/behavior-models`;
      const { response, data } = await fetchBehaviorJsonWithTimeout(url, {
        method: customComplete ? 'POST' : 'GET',
        headers: getBehaviorAuthHeaders(),
        body: customComplete ? JSON.stringify({ endpoint: customEndpoint, key: customKey }) : undefined
      });
      if (!response.ok) throw new Error(data?.error || `模型列表读取失败 ${response.status}`);
      const models = Array.isArray(data?.models) ? data.models : [];
      setBehaviorModelOptions(models);
      const preferredModel = behaviorConfig.model_name || data?.model_name || behaviorCharacter?.model_name || '';
      if (!behaviorConfig.model_name && (models.includes(preferredModel) || preferredModel)) {
        updateBehaviorConfig({ model_name: preferredModel || models[0] });
      } else if (!behaviorConfig.model_name && models[0]) {
        updateBehaviorConfig({ model_name: models[0] });
      }
      const message = models.length
        ? `已通过${sourceLabel}拉取 ${models.length} 个模型。`
        : '模型接口返回为空，可以手动填写模型名。';
      setBehaviorModelStatus(message);
      setBehaviorStatus(message);
    } catch (error) {
      const message = `模型拉取失败：${error.name === 'AbortError' ? '请求超时' : error.message}`;
      setBehaviorModelStatus(message);
      setBehaviorStatus(message);
    } finally {
      setBehaviorModelsLoading(false);
    }
  }

  async function requestBehaviorInput() {
    if (!behaviorCharacterId) {
      setBehaviorStatus('没有可用角色，先在角色设置里创建或启用一个角色。');
      return;
    }
    setBehaviorLoading(true);
    setBehaviorStatus('正在读取大输入背景...');
    const requestPayload = buildBehaviorPayload();
    setBehaviorInput({
      ...requestPayload,
      debug_source: 'client_pending_behavior_input_request',
      debug_note: '正在请求服务端补齐 large_input。'
    });
    setBehaviorOutput(null);
    try {
      const response = await fetch(`${apiUrl}/city/characters/${encodeURIComponent(behaviorCharacterId)}/behavior-input`, {
        method: 'POST',
        headers: getBehaviorAuthHeaders(),
        body: JSON.stringify(requestPayload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `读取失败 ${response.status}`);
      setBehaviorInput(data.input || null);
      setBehaviorOutput(null);
      setBehaviorStatus('已读取大输入背景；私聊和商业街活动只作背景，不会触发小人行动。');
    } catch (error) {
      setBehaviorStatus(`大输入背景读取失败：${error.message}`);
    } finally {
      setBehaviorLoading(false);
    }
  }

  async function generateBehaviorBranch(options = {}) {
    if (!behaviorCharacterId) {
      setBehaviorStatus('没有可用角色，先在角色设置里创建或启用一个角色。');
      return;
    }
    const actionId = options.actionId || behaviorAction;
    const placeId = options.placeId || behaviorPlaceId;
    const selectedAction = resolveBehaviorAction(actionId);
    if (actionId !== behaviorAction) setBehaviorAction(actionId);
    if (placeId && placeId !== behaviorPlaceId) setBehaviorPlaceId(placeId);
    setBehaviorLoading(true);
    setBehaviorStatus('正在生成玩家特殊枝丫...');
    setPlayerActionBubble(selectedAction?.label || '互动');
    const requestPayload = buildBehaviorPayload({ actionId, placeId });
    setBehaviorInput(buildBehaviorPendingInput(
      { actionId, placeId },
      '当前点击选项产生的请求；服务端会重新补齐 large_input。'
    ));
    setBehaviorOutput(null);
    try {
      const { response, data } = await fetchBehaviorJsonWithTimeout(`${apiUrl}/city/characters/${encodeURIComponent(behaviorCharacterId)}/behavior-branch`, {
        method: 'POST',
        headers: getBehaviorAuthHeaders(),
        body: JSON.stringify({
          ...requestPayload,
          api_endpoint: behaviorConfig.api_endpoint,
          api_key: behaviorConfig.api_key,
          model_name: behaviorConfig.model_name
        })
      }, 45000);
      if (!response.ok) throw new Error(data?.error || `生成失败 ${response.status}`);
      setBehaviorInput(data.input || null);
      const source = 'ai';
      const patchResult = mergeBehaviorTreePatch(data.tree_patch || data.patch, data.branch, source);
      setBehaviorOutput({
        branch: data.branch || null,
        tree_patch: patchResult?.patch || data.tree_patch || data.patch || null,
        tree_version: patchResult?.tree?.version || behaviorTreeState.version,
        fallback: false,
        error: data.error || '',
        raw_output: data.raw_output || ''
      });
      if (patchResult?.activeBranch) activateBehaviorBranch(patchResult.activeBranch, source);
      setBehaviorStatus('AI patch 已合并进完整行为树。');
      return { ok: true, patchResult };
    } catch (error) {
      const message = formatBehaviorRequestError(error, '特殊枝丫生成失败，请重试。');
      setBehaviorStatus(`特殊枝丫生成失败：${message}`);
      setBehaviorOutput({
        branch: null,
        tree_patch: null,
        tree_version: behaviorTreeState.version,
        fallback: false,
        error: message,
        raw_output: ''
      });
      return { ok: false, error: message };
    } finally {
      setBehaviorLoading(false);
    }
  }

  async function generateBaseBehaviorBranches() {
    if (!behaviorCharacterId) {
      setBehaviorStatus('没有可用角色，先在角色设置里创建或启用一个角色。');
      return;
    }
    setBehaviorLoading(true);
    setBehaviorStatus('正在生成基础枝丫包...');
    const requestPayload = buildBehaviorPayload();
    setBehaviorInput({
      ...requestPayload,
      debug_source: 'client_pending_behavior_base_request',
      debug_note: '当前基础枝丫生成请求；服务端会重新补齐 large_input。'
    });
    setBehaviorOutput(null);
    try {
      const response = await fetch(`${apiUrl}/city/characters/${encodeURIComponent(behaviorCharacterId)}/behavior-base-branches`, {
        method: 'POST',
        headers: getBehaviorAuthHeaders(),
        body: JSON.stringify({
          ...requestPayload,
          api_endpoint: behaviorConfig.api_endpoint,
          api_key: behaviorConfig.api_key,
          model_name: behaviorConfig.model_name
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `生成失败 ${response.status}`);
      setBehaviorInput(data.input || null);
      const source = 'ai-base';
      const patchResult = mergeBehaviorTreePatches(data.base_patches || [], source);
      const branchCount = patchResult?.patches?.length || data.base_branches?.length || 0;
      setBehaviorOutput({
        base_branches: data.base_branches || [],
        base_patches: patchResult?.patches || data.base_patches || [],
        tree_version: patchResult?.tree?.version || behaviorTreeState.version,
        fallback: false,
        error: data.error || '',
        raw_output: data.raw_output || ''
      });
      autonomousBehaviorCursorRef.current = 0;
      autonomousBehaviorRecentRef.current = [];
      setBehaviorStatus(`AI 基础枝丫 ${branchCount} 条已合并进基础池。`);
    } catch (error) {
      setBehaviorStatus(`基础枝丫生成失败：${error.message}`);
    } finally {
      setBehaviorLoading(false);
    }
  }

  function mergeBehaviorTreePatch(rawPatch, fallbackBranch = null, source = 'manual') {
    const patch = rawPatch || (fallbackBranch ? createCommercialBehaviorPatchFromBranch(fallbackBranch, source) : null);
    const result = applyCommercialBehaviorTreePatch(behaviorTreeState, {
      ...(patch || {}),
      source,
      branch: fallbackBranch || patch?.branch
    });
    if (!result.patch) return null;
    setBehaviorTreeState(result.tree);
    setBehaviorPatchOutput({
      patch: result.patch,
      active_node_id: result.tree.active_node_id,
      tree_version: result.tree.version,
      patch_history: result.tree.patch_history.slice(0, 6)
    });
    return result;
  }

  function mergeBehaviorTreePatches(rawPatches = [], source = 'manual') {
    if (!Array.isArray(rawPatches) || !rawPatches.length) return null;
    let nextTree = behaviorTreeState;
    const patches = [];
    rawPatches.forEach((rawPatch) => {
      const result = applyCommercialBehaviorTreePatch(nextTree, {
        ...(rawPatch || {}),
        source
      });
      if (!result.patch) return;
      nextTree = result.tree;
      patches.push(result.patch);
    });
    if (!patches.length) return null;
    setBehaviorTreeState(nextTree);
    setBehaviorPatchOutput({
      patches,
      count: patches.length,
      active_node_id: nextTree.active_node_id,
      tree_version: nextTree.version,
      patch_history: nextTree.patch_history.slice(0, 10)
    });
    return { tree: nextTree, patches };
  }

  function behaviorBranchUsesOnlyAvailablePlaces(branch) {
    const allowedPlaceIds = new Set(behaviorOrderedPlaces.map((place) => place.placeId));
    if (!allowedPlaceIds.size || !Array.isArray(branch?.steps)) return false;
    return branch.steps.every((step) => {
      const rawIds = [
        step?.place_id,
        step?.placeId,
        step?.from_place_id,
        step?.fromPlaceId,
        step?.to_place_id,
        step?.toPlaceId,
        step?.target_place_id,
        step?.targetPlaceId
      ].map((value) => String(value || '').trim()).filter(Boolean);
      return rawIds.every((id) => allowedPlaceIds.has(id));
    });
  }

  function pickAutonomousBehaviorBranch(options = {}) {
    const tree = behaviorTreeStateRef.current || behaviorTreeState || createCommercialV2BehaviorTreeState();
    const nodes = tree.nodes || {};
    const dynamicBaseNodeIds = commercialV2BehaviorBaseNodeIds
      .flatMap((nodeId) => Array.isArray(nodes[nodeId]?.children_ids) ? nodes[nodeId].children_ids : [])
      .filter(Boolean);
    const sourceNodeIds = options.nearby
      ? Array.from(new Set([...commercialV2BehaviorNearbyAutonomousNodeIds, ...dynamicBaseNodeIds, ...commercialV2BehaviorAutonomousNodeIds]))
      : Array.from(new Set([...(dynamicBaseNodeIds.length ? dynamicBaseNodeIds : commercialV2BehaviorAutonomousNodeIds), ...commercialV2BehaviorAutonomousNodeIds]));
    const candidates = sourceNodeIds
      .map((nodeId) => createCommercialBehaviorBranchFromNode(nodes[nodeId]))
      .filter((branch) => branch && behaviorBranchUsesOnlyAvailablePlaces(branch));
    if (!candidates.length) return null;
    const recentIds = autonomousBehaviorRecentRef.current || [];
    const freshCandidates = candidates.length > 3
      ? candidates.filter((branch) => !recentIds.includes(branch.branch_id))
      : candidates;
    const playableCandidates = freshCandidates.length ? freshCandidates : candidates;
    const cursor = autonomousBehaviorCursorRef.current % playableCandidates.length;
    autonomousBehaviorCursorRef.current += 1;
    const selected = playableCandidates[cursor];
    autonomousBehaviorRecentRef.current = [
      selected.branch_id,
      ...recentIds.filter((id) => id !== selected.branch_id)
    ].slice(0, Math.min(4, Math.max(1, candidates.length - 1)));
    return selected;
  }

  function runPlayerInteraction(actionId) {
    if (!behaviorInteractionState.nearby || behaviorLoading) return;
    const selectedAction = resolveBehaviorAction(actionId);
    const selectedPlace = resolveBehaviorPlace(behaviorPlaceId);
    const selectedPlaceId = selectedPlace?.id || behaviorPlaceId || 'restaurant';
    const selectedPlaceLabel = selectedPlace?.label || '街区';
    if (actionId !== behaviorAction) setBehaviorAction(actionId);
    setInteractionMenuOpen(false);
    if (behaviorRuntimeRef.current?.source === 'base') {
      clearBehaviorRuntime('');
    }
    const presetBranch = createCommercialV2PresetInteractionBranch(
      actionId,
      selectedPlaceId,
      selectedPlaceLabel
    );
    setBehaviorInput(buildBehaviorPendingInput(
      { actionId, placeId: selectedPlaceId },
      '当前预制互动请求；枝丫末尾选项会用这个动作继续生成。'
    ));
    executeBehaviorBranch(presetBranch, 'preset');
    setPlayerActionBubble(selectedAction?.label || '互动');
    setBehaviorStatus(`已触发预制互动：${presetBranch.title}。请选择枝丫末尾选项生成后续。`);
  }

  function resolveBehaviorChoiceTrigger(choice = {}) {
    return [
      choice?.trigger,
      choice?.action_id,
      choice?.actionId,
      choice?.next_action,
      choice?.nextAction,
      choice?.player_action,
      choice?.playerAction,
      choice?.id,
      choice?.action
    ]
      .map((value) => String(value || '').trim())
      .find((value) => commercialV2BehaviorActionIds.has(value)) || '';
  }

  function normalizeBehaviorDialogChoices(choices) {
    if (!Array.isArray(choices)) return [];
    return choices.slice(0, 4).map((choice, index) => {
      if (typeof choice === 'string') {
        const label = choice.trim();
        const trigger = commercialV2BehaviorActionIds.has(label) ? label : '';
        return label && trigger ? { id: trigger, label, trigger } : null;
      }
      if (!choice || typeof choice !== 'object') return null;
      const label = String(choice.label || choice.text || choice.title || `选项 ${index + 1}`).trim();
      const trigger = resolveBehaviorChoiceTrigger(choice);
      if (!trigger) return null;
      return {
        ...choice,
        id: String(choice.id || trigger || `choice_${index + 1}`),
        label: label || `选项 ${index + 1}`,
        trigger
      };
    }).filter(Boolean);
  }

  function continueBehaviorDialog() {
    const runtime = behaviorRuntimeRef.current;
    if (runtime && activeBehaviorDialog?.runtimeId === runtime.id) {
      runtime.waitingForDialog = false;
      runtime.waitingForChoice = false;
      runtime.stepIndex += 1;
      runtime.waitingUntil = Date.now() + 120;
      setBehaviorStatus('已继续执行当前行为枝丫。');
    }
    setActiveBehaviorDialog(null);
  }

  async function chooseBehaviorDialogChoice(choice) {
    if (behaviorChoicePendingRef.current || behaviorLoading) {
      setBehaviorStatus('正在处理上一个玩家回应，请稍等。');
      return;
    }
    const triggerAction = resolveBehaviorChoiceTrigger(choice);
    const nextPlaceId = String(choice?.place_id || choice?.placeId || choice?.to_place_id || choice?.toPlaceId || behaviorPlaceId || '').trim();
    if (!triggerAction) {
      setBehaviorStatus('该选项缺少有效后续动作，请换一个回应。');
      setActiveBehaviorDialog((current) => current
        ? { ...current, text: '该选项缺少有效后续动作，请换一个回应。' }
        : current);
      return;
    }
    behaviorChoicePendingRef.current = true;
    const selectedLabel = String(choice?.label || choice?.text || '这个回应').trim();
    const previousDialog = activeBehaviorDialog;
    setInteractionMenuOpen(false);
    setBehaviorStatus(`已选择“${selectedLabel}”，正在生成后续特殊枝丫...`);
    setActiveBehaviorDialog({
      runtimeId: activeBehaviorDialog?.runtimeId || '',
      type: 'pending',
      title: behaviorCharacter?.name || '角色',
      text: `已选择“${selectedLabel}”，正在生成后续特殊枝丫...`,
      choices: [],
      stepIndex: activeBehaviorDialog?.stepIndex || 0,
      totalSteps: activeBehaviorDialog?.totalSteps || 1
    });
    try {
      const branchResult = await generateBehaviorBranch({ actionId: triggerAction, placeId: nextPlaceId || behaviorPlaceId });
      if (!branchResult?.ok) {
        setActiveBehaviorDialog({
          ...(previousDialog || {}),
          runtimeId: previousDialog?.runtimeId || '',
          type: 'choice',
          title: previousDialog?.title || behaviorCharacter?.name || '角色',
          text: `后续枝丫生成失败：${branchResult?.error || '请重试。'}`,
          choices: previousDialog?.choices?.length ? previousDialog.choices : [choice],
          stepIndex: previousDialog?.stepIndex || 0,
          totalSteps: previousDialog?.totalSteps || 1
        });
        return;
      }
      setActiveBehaviorDialog((current) => current?.type === 'pending' ? null : current);
    } finally {
      behaviorChoicePendingRef.current = false;
    }
  }

  function executeBehaviorBranch(branch, source = 'manual') {
    if (!branch) {
      setBehaviorStatus('当前没有可执行的枝丫。');
      return;
    }
    const patchResult = mergeBehaviorTreePatch(createCommercialBehaviorPatchFromBranch(branch, source), branch, source);
    setBehaviorOutput({
      branch,
      tree_patch: patchResult?.patch || null,
      tree_version: patchResult?.tree?.version || behaviorTreeState.version,
      fallback: source !== 'ai',
      error: '',
      raw_output: JSON.stringify(branch, null, 2)
    });
    if (patchResult?.activeBranch) activateBehaviorBranch(patchResult.activeBranch, source);
    setBehaviorStatus(source === 'demo' ? '已把 demo patch 合并进完整行为树，并开始执行。' : '已重新合并当前输出 patch 并执行。');
  }

  function renderPlayerInteractionMenu() {
    if (!behaviorInteractionState.nearby || activeBehaviorDialog) return null;
    const style = {
      left: `${(behaviorInteractionState.x / stageSize.width) * 100}%`,
      top: `${(behaviorInteractionState.y / stageSize.height) * 100}%`
    };
    const sideClass = behaviorInteractionState.side === 'left' ? 'side-left' : 'side-right';
    if (!interactionMenuOpen) {
      return (
        <button
          type="button"
          className={`pixel-world-interaction-entry ${sideClass}`}
          style={style}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setInteractionMenuOpen(true)}
          disabled={behaviorLoading || !behaviorCharacterId}
        >
          <strong>{behaviorLoading ? '生成中' : '互动'}</strong>
          <span>{behaviorCharacter?.name || '角色'}</span>
        </button>
      );
    }
    return (
      <div
        className={`pixel-world-interaction-menu ${sideClass}`}
        style={style}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="pixel-world-interaction-menu-head">
          <strong>{behaviorCharacter?.name || '角色'}</strong>
          <button
            type="button"
            className="pixel-world-interaction-close"
            onClick={() => setInteractionMenuOpen(false)}
          >
            收起
          </button>
        </div>
        <div className="pixel-world-interaction-menu-primary">
          {behaviorPrimaryActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={behaviorAction === action.id ? 'active' : ''}
              disabled={behaviorLoading || !behaviorCharacterId}
              title={action.hint}
              onClick={() => runPlayerInteraction(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="pixel-world-interaction-menu-target">
          <span>目的地</span>
          <select
            value={behaviorPlaceId}
            onChange={(event) => setBehaviorPlaceId(event.target.value)}
            disabled={behaviorLoading || !behaviorPlaceOptions.length}
            aria-label="互动目的地"
          >
            {behaviorPlaceOptions.length ? behaviorPlaceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.order ? `${option.order}. ` : ''}{option.label}
              </option>
            )) : (
              <option value="">暂无地点</option>
            )}
          </select>
        </div>
        <div className="pixel-world-interaction-menu-context">
          {behaviorContextActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={behaviorAction === action.id ? 'active' : ''}
              disabled={behaviorLoading || !behaviorCharacterId}
              title={action.hint}
              onClick={() => runPlayerInteraction(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderBehaviorActorCard(actorId, title, note) {
    const character = commercialV2PlayerCharacterById.get(actorId) || commercialV2PlayerCharacters[0];
    const actor = players[actorId] || createCommercialV2PlayerState(character);
    return (
      <div className={`pixel-world-behavior-actor ${actorId === commercialV2RoleActorId ? 'role' : 'user'}`}>
        <img src={commercialV2PlayerFrame(actor, `${actor.direction || 'front'}_walk_idle.png`)} alt="" draggable={false} />
        <div>
          <strong>{title}</strong>
          <span>{character.label} · 平移街区</span>
          <small>{note}</small>
        </div>
      </div>
    );
  }

  function toggleBehaviorFold(key) {
    setBehaviorFoldOpen((current) => ({
      ...current,
      [key]: !current[key]
    }));
  }

  function renderBehaviorFold(key, title, summary, children) {
    const open = behaviorFoldOpen[key];
    return (
      <section className={`pixel-world-behavior-fold ${open ? 'open' : ''}`}>
        <button
          type="button"
          className="pixel-world-behavior-fold-head"
          onClick={() => toggleBehaviorFold(key)}
          aria-expanded={open}
        >
          <span>{title}</span>
          {summary && <small>{summary}</small>}
          <strong>{open ? '收起' : '展开'}</strong>
        </button>
        {open && (
          <div className="pixel-world-behavior-fold-body">
            {children}
          </div>
        )}
      </section>
    );
  }

  function renderBehaviorTreePanel() {
    if (behaviorPanelCollapsed) {
      return (
        <aside className="pixel-world-behavior-panel collapsed">
          <button
            type="button"
            className="pixel-world-behavior-panel-expand"
            onClick={() => setBehaviorPanelCollapsed(false)}
            title="展开行为树面板"
            aria-label="展开行为树面板"
          >
            <span>行为树</span>
            <strong>{behaviorOutput?.fallback ? 'Fallback' : behaviorOutput ? 'AI' : 'Draft'}</strong>
            <small>展开</small>
          </button>
        </aside>
      );
    }

    return (
      <aside className="pixel-world-behavior-panel">
        <div className="pixel-world-behavior-head">
          <div>
            <h3>行为树 V1</h3>
            <span>单角色街区行为运行时</span>
          </div>
          <div className="pixel-world-behavior-head-actions">
            <strong>{behaviorOutput?.fallback ? 'Fallback' : behaviorOutput ? 'AI' : 'Draft'}</strong>
            <button
              type="button"
              onClick={() => setBehaviorPanelCollapsed(true)}
              title="收起整个行为树面板"
            >
              收起
            </button>
          </div>
        </div>

        <div className="pixel-world-behavior-actors">
          {renderBehaviorActorCard(commercialV2RoleActorId, '角色小人', behaviorCharacter?.name ? `绑定：${behaviorCharacter.name}` : '等待绑定角色')}
          {renderBehaviorActorCard(commercialV2UserActorId, '玩家小人', userProfile?.name ? `玩家：${userProfile.name}` : '玩家控制入口')}
        </div>

        <label className="pixel-world-behavior-field">
          <span>绑定角色</span>
          <select
            value={behaviorCharacterId}
            onChange={(event) => setBehaviorCharacterId(event.target.value)}
            disabled={!behaviorCharacters.length}
          >
            {behaviorCharacters.length ? behaviorCharacters.map((item) => (
              <option key={item.id} value={item.id}>{item.name || item.id}</option>
            )) : (
              <option value="">暂无角色</option>
            )}
          </select>
        </label>

        {renderBehaviorFold(
          'model',
          '模型配置',
          behaviorConfig.model_name || behaviorCharacter?.model_name || '使用绑定角色',
          (
            <div className="pixel-world-behavior-model-grid">
              <label className="pixel-world-behavior-field">
                <span>URL</span>
                <input
                  value={behaviorConfig.api_endpoint}
                  onChange={(event) => updateBehaviorConfig({ api_endpoint: event.target.value })}
                  placeholder={behaviorCharacter?.api_endpoint ? '留空使用绑定角色 URL' : 'https://api.example.com/v1'}
                />
              </label>
              <label className="pixel-world-behavior-field">
                <span>Key</span>
                <input
                  type={behaviorShowKey ? 'text' : 'password'}
                  value={behaviorConfig.api_key}
                  onChange={(event) => updateBehaviorConfig({ api_key: event.target.value })}
                  placeholder="留空使用绑定角色 Key"
                />
              </label>
              <label className="pixel-world-behavior-field">
                <span>模型</span>
                <input
                  list="pixel-world-behavior-models"
                  value={behaviorConfig.model_name}
                  onChange={(event) => updateBehaviorConfig({ model_name: event.target.value })}
                  placeholder={behaviorCharacter?.model_name || '模型名'}
                />
                <datalist id="pixel-world-behavior-models">
                  {behaviorModelOptions.map((model) => <option key={model} value={model} />)}
                </datalist>
              </label>
              <div className="pixel-world-behavior-model-actions">
                <button type="button" onClick={pullBehaviorModels} disabled={behaviorModelsLoading}>
                  {behaviorModelsLoading ? '拉取中' : '拉取模型'}
                </button>
                <button type="button" onClick={() => setBehaviorShowKey((value) => !value)}>
                  {behaviorShowKey ? '隐藏 Key' : '显示 Key'}
                </button>
              </div>
              <div className={`pixel-world-behavior-model-status ${behaviorModelStatus.includes('失败') ? 'error' : ''}`}>
                {behaviorModelStatus}
              </div>
              {behaviorModelOptions.length > 0 && (
                <div className="pixel-world-behavior-model-list">
                  <div className="pixel-world-behavior-model-list-head">
                    <strong>模型列表</strong>
                    <span>{behaviorModelOptions.length} 个</span>
                  </div>
                  <div className="pixel-world-behavior-model-options">
                    {behaviorModelOptions.map((model) => (
                      <button
                        key={model}
                        type="button"
                        className={behaviorConfig.model_name === model ? 'active' : ''}
                        title={model}
                        onClick={() => updateBehaviorConfig({ model_name: model })}
                      >
                        {model}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {renderBehaviorFold(
          'constraints',
          'AI 可选白名单',
          `${behaviorOrderedPlaces.length} 地点 / ${commercialV2BehaviorMovementActions.length} 移动枝丫`,
          (
            <div className="pixel-world-behavior-constraints">
              <div>
                <strong>地点</strong>
                <div className="pixel-world-behavior-chip-list">
                  {behaviorOrderedPlaces.map((place) => (
                    <span key={place.placeId}>{place.order}. {place.name}</span>
                  ))}
                </div>
              </div>
              <div>
                <strong>移动枝丫</strong>
                <div className="pixel-world-behavior-chip-list">
                  {commercialV2BehaviorMovementActions.map((action) => (
                    <span key={action.id}>{action.label}</span>
                  ))}
                </div>
              </div>
            </div>
          )
        )}

        {renderBehaviorFold(
          'branchMap',
          '枝丫分层',
          '基础枝 / 特殊枝',
          (
            <div className="pixel-world-behavior-branch-map">
              <div>
                <strong>特殊枝丫</strong>
                <span>player_interaction · 玩家点击互动或选择回应后，AI 局部 patch 到这里。</span>
              </div>
              <div>
                <strong>基础枝丫</strong>
                <span>无互动时自动轮询：硬需求、本地例行、地点能力、背景情绪、好奇、自由活动、微动作。</span>
              </div>
            </div>
          )
        )}

        {renderBehaviorFold(
          'interaction',
          '互动设置',
          behaviorInteractionState.nearby ? `距离 ${Math.round(behaviorInteractionState.distance)} / ${commercialV2BehaviorInteractionDistance}` : '靠近后弹出菜单',
          (
            <>
              <div className={`pixel-world-behavior-proximity ${behaviorInteractionState.nearby ? 'nearby' : ''}`}>
                <strong>{behaviorInteractionState.nearby ? '角色已在互动范围' : '玩家靠近角色后弹出菜单'}</strong>
                <span>距离 {Math.round(behaviorInteractionState.distance)} / {commercialV2BehaviorInteractionDistance}</span>
              </div>

        <label className="pixel-world-behavior-field">
          <span>目标地点</span>
          <select
            value={behaviorPlaceId}
            onChange={(event) => setBehaviorPlaceId(event.target.value)}
            disabled={!behaviorPlaceOptions.length}
          >
            {behaviorPlaceOptions.length ? behaviorPlaceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.order ? `${option.order}. ` : ''}{option.label}
              </option>
            )) : (
              <option value="">暂无地点</option>
            )}
          </select>
        </label>
        <label className="pixel-world-behavior-field">
          <span>补充输入</span>
          <textarea
            value={behaviorPromptText}
            onChange={(event) => setBehaviorPromptText(event.target.value)}
            placeholder="例如：玩家想让角色陪自己去便利店，但别太听话，要有一点临场反应。"
          />
        </label>

        <div className="pixel-world-behavior-run-row">
          <button type="button" onClick={requestBehaviorInput} disabled={behaviorLoading || !behaviorCharacterId}>
            读取大输入
          </button>
          <button type="button" onClick={generateBaseBehaviorBranches} disabled={behaviorLoading || !behaviorCharacterId}>
            生成基础枝丫
          </button>
          <button type="button" className="primary" onClick={generateBehaviorBranch} disabled={behaviorLoading || !behaviorCharacterId}>
            调试生成后续
          </button>
          <button
            type="button"
            onClick={() => {
              const branch = pickAutonomousBehaviorBranch();
              if (!branch) {
                setBehaviorStatus('当前没有可执行的基础枝丫，先确认地点白名单是否存在。');
                return;
              }
              autonomousBehaviorCooldownRef.current = Date.now() + commercialV2BehaviorAutonomousCooldownMs;
              activateBehaviorBranch(branch, 'base');
              setBehaviorStatus(`已手动执行基础枝丫：${branch.title}`);
            }}
            disabled={behaviorLoading || !behaviorCharacterId}
          >
            执行基础枝
          </button>
          <button type="button" onClick={() => executeBehaviorBranch(behaviorOutput?.branch, 'replay')} disabled={behaviorLoading || !behaviorOutput?.branch}>
            重放当前输出
          </button>
          <button type="button" onClick={() => executeBehaviorBranch(commercialV2BehaviorLastDemoBranch, 'demo')} disabled={behaviorLoading}>
            填入刚刚枝丫
          </button>
          <button
            type="button"
            onClick={() => {
              const resetTree = createCommercialV2BehaviorTreeState();
              setBehaviorTreeState(resetTree);
              setBehaviorPatchOutput(null);
              setBehaviorStatus('完整行为树已重置。');
            }}
            disabled={behaviorLoading}
          >
            重置完整树
          </button>
        </div>
            </>
          )
        )}

        {renderBehaviorFold(
          'runtime',
          '运行状态',
          activeBehaviorBranch ? activeBehaviorBranch.title : `版本 ${behaviorTreeState.version} · patch ${behaviorTreeState.patch_history?.length || 0}`,
          (
            <>
              <div className="pixel-world-behavior-status">{behaviorLoading ? '处理中...' : behaviorStatus}</div>
              <div className={`pixel-world-behavior-runtime ${activeBehaviorBranch ? 'active' : ''}`}>
          {activeBehaviorBranch ? (
            <>
              <strong>{activeBehaviorBranch.branchKindLabel || '完整树运行节点'}</strong>
              <span>{activeBehaviorBranch.title}</span>
              <small>
                {Math.min((activeBehaviorBranch.stepIndex || 0) + 1, activeBehaviorBranch.totalSteps || 1)}
                /{activeBehaviorBranch.totalSteps || 1}
                {activeBehaviorBranch.currentAction ? ` · ${activeBehaviorBranch.currentAction}` : ''}
                {behaviorTreeState?.active_node_id ? ` · node:${behaviorTreeState.active_node_id}` : ''}
              </small>
              {activeBehaviorDialog && (
                <div className="pixel-world-behavior-runtime-control">
                  <strong>{activeBehaviorDialog.type === 'choice' ? '等待玩家选择' : '等待点击下一句'}</strong>
                  <p>{activeBehaviorDialog.text}</p>
                  {activeBehaviorDialog.type === 'pending' ? (
                    <button type="button" disabled>生成中...</button>
                  ) : activeBehaviorDialog.type === 'choice' && activeBehaviorDialog.choices?.length ? (
                    <div className="pixel-world-behavior-runtime-choice-grid">
                      {activeBehaviorDialog.choices.map((choice) => (
                        <button
                          key={choice.id}
                          type="button"
                          onClick={() => chooseBehaviorDialogChoice(choice)}
                          disabled={behaviorLoading}
                        >
                          {choice.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button type="button" onClick={continueBehaviorDialog}>下一句</button>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <strong>完整行为树</strong>
              <span>版本 {behaviorTreeState.version} · patch {behaviorTreeState.patch_history?.length || 0}</span>
              <small>基础枝丫自动执行；玩家互动会返回局部 patch，合并进特殊互动枝后执行。</small>
            </>
          )}
              </div>
            </>
          )
        )}

        {renderBehaviorFold(
          'debug',
          '调试 JSON',
          '完整树 / 输入 / Patch / 输出',
          (
            <div className="pixel-world-behavior-json-grid">
              <section>
                <h4>完整树</h4>
                <pre>{formatBehaviorJson(behaviorTreeState)}</pre>
              </section>
              <section>
                <h4>输入</h4>
                <pre>{formatBehaviorJson(behaviorInput || buildBehaviorPayload())}</pre>
              </section>
              <section>
                <h4>Patch</h4>
                <pre>{formatBehaviorJson(behaviorPatchOutput || { patch: null, note: '生成后显示本次局部行为树 patch。' })}</pre>
              </section>
              <section>
                <h4>输出</h4>
                <pre>{formatBehaviorJson(behaviorOutput || { base_branches: null, branch: null, tree_patch: null, note: '点击“生成基础枝丫”显示基础枝丫包；互动按钮会先播放预制枝丫，枝丫末尾选项才生成后续 patch。' })}</pre>
              </section>
            </div>
          )
        )}
      </aside>
    );
  }

  function cancelAssetDrag() {
    if (dragFrameRef.current) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    pendingDragPointRef.current = null;
    dragRef.current = null;
  }

  function toggleViewMode() {
    setViewMode((enabled) => {
      const next = !enabled;
      if (next) {
        cancelAssetDrag();
        setGroupEditMode(false);
        setSelectedId('');
        setNotice('观赏模式已开启：素材已锁定，可以安心浏览和控制小人。');
      } else {
        setNotice('观赏模式已关闭：现在可以选中、拖动和编辑素材。');
      }
      return next;
    });
  }

  const getPlayerFootBox = useCallback((x, y) => {
    const footWidth = Math.max(12, playerDimensions.width * 0.28);
    const footHeight = Math.max(8, playerDimensions.footOffset * 0.75);
    return {
      x: wrapLoopCoordinate(x, stageSize.width) - footWidth / 2,
      y: y - footHeight / 2,
      w: footWidth,
      h: footHeight
    };
  }, [playerDimensions.footOffset, playerDimensions.width, stageSize.width]);

  const getPlayerPeerCollisionBox = useCallback((x, y) => {
    const width = Math.max(
      commercialV2PlayerPeerCollision.minWidth,
      playerDimensions.width * commercialV2PlayerPeerCollision.widthRatio
    );
    const height = Math.max(
      commercialV2PlayerPeerCollision.minHeight,
      playerDimensions.footOffset * commercialV2PlayerPeerCollision.heightRatio
    );
    return {
      x: wrapLoopCoordinate(x, stageSize.width) - width / 2,
      y: y - height / 2,
      w: width,
      h: height
    };
  }, [playerDimensions.footOffset, playerDimensions.width, stageSize.width]);

  const getPlayerCollisionProbeBoxes = useCallback((x, y) => {
    const footBox = getPlayerFootBox(x, y);
    const upperProbeHeight = Math.max(8, Math.min(26, playerDimensions.footOffset * 1.6));
    return [
      footBox,
      {
        x: footBox.x,
        y: footBox.y - upperProbeHeight,
        w: footBox.w,
        h: upperProbeHeight
      }
    ];
  }, [getPlayerFootBox, playerDimensions.footOffset]);

  const isPlayerPointWalkable = useCallback((x, y) => {
    if (!walkableRects.length) return true;
    const pointX = wrapLoopCoordinate(x, stageSize.width);
    return walkableRects.some((rect) => [-stageSize.width, 0, stageSize.width].some((offset) => (
      pointX >= rect.x + offset
      && pointX <= rect.x + offset + rect.w
      && y >= rect.y
      && y <= rect.y + rect.h
    )));
  }, [stageSize.width, walkableRects]);

  const isPlayerBlockedByOtherPlayers = useCallback((x, y, options = {}) => {
    if (options.ignorePlayers) return false;
    const ignorePlayerId = options.ignorePlayerId || controlledPlayerIdRef.current;
    const currentPlayers = options.players || playersRef.current;
    const playerBox = getPlayerPeerCollisionBox(x, y);
    return commercialV2PlayerCharacters.some((character) => {
      if (character.id === ignorePlayerId) return false;
      const otherPlayer = currentPlayers[character.id];
      if (!otherPlayer) return false;
      const otherBox = getPlayerPeerCollisionBox(otherPlayer.x, otherPlayer.y);
      return [-stageSize.width, 0, stageSize.width].some((offset) => boxesOverlap(playerBox, {
        x: otherBox.x + offset,
        y: otherBox.y,
        w: otherBox.w,
        h: otherBox.h
      }));
    });
  }, [getPlayerPeerCollisionBox, stageSize.width]);

  const isPlayerFootBlocked = useCallback((x, y) => {
    if (!collisionRects.length) return false;
    const probeBoxes = getPlayerCollisionProbeBoxes(x, y);
    return collisionRects.some((rect) => [-stageSize.width, 0, stageSize.width].some((offset) => {
      const shiftedRect = {
        x: rect.x + offset,
        y: rect.y,
        w: rect.w,
        h: rect.h
      };
      return probeBoxes.some((box) => boxesOverlap(box, shiftedRect));
    }));
  }, [collisionRects, getPlayerCollisionProbeBoxes, stageSize.width]);

  const isAutoTravelFootBlocked = useCallback((x, y) => {
    if (!autoRouteBlockRects.length) return false;
    const probeBoxes = getPlayerCollisionProbeBoxes(x, y);
    return autoRouteBlockRects.some((rect) => [-stageSize.width, 0, stageSize.width].some((offset) => {
      const shiftedRect = {
        x: rect.x + offset,
        y: rect.y,
        w: rect.w,
        h: rect.h
      };
      return probeBoxes.some((box) => boxesOverlap(box, shiftedRect));
    }));
  }, [autoRouteBlockRects, getPlayerCollisionProbeBoxes, stageSize.width]);

  const isPlayerPositionAllowed = useCallback((x, y, options = {}) => (
    isPlayerPointWalkable(x, y)
    && !isPlayerFootBlocked(x, y)
    && !isPlayerBlockedByOtherPlayers(x, y, options)
  ), [isPlayerBlockedByOtherPlayers, isPlayerFootBlocked, isPlayerPointWalkable]);

  const isAutoTravelPositionAllowed = useCallback((x, y, options = {}) => (
    isPlayerPointWalkable(x, y)
    && !isAutoTravelFootBlocked(x, y)
    && !isPlayerBlockedByOtherPlayers(x, y, options)
  ), [isAutoTravelFootBlocked, isPlayerBlockedByOtherPlayers, isPlayerPointWalkable]);

  const isMainRoadPoint = useCallback((x, y) => {
    if (!mainRoadRects.length) return false;
    const pointX = wrapLoopCoordinate(x, stageSize.width);
    return mainRoadRects.some((rect) => [-stageSize.width, 0, stageSize.width].some((offset) => (
      pointX >= rect.x + offset
      && pointX <= rect.x + offset + rect.w
      && y >= rect.y
      && y <= rect.y + rect.h
    )));
  }, [mainRoadRects, stageSize.width]);

  const isStreetCruiseRoadPoint = useCallback((x, y) => {
    if (!streetCruiseRoadRects.length) return false;
    const pointX = wrapLoopCoordinate(x, stageSize.width);
    return streetCruiseRoadRects.some((rect) => [-stageSize.width, 0, stageSize.width].some((offset) => (
      pointX >= rect.x + offset
      && pointX <= rect.x + offset + rect.w
      && y >= rect.y
      && y <= rect.y + rect.h
    )));
  }, [stageSize.width, streetCruiseRoadRects]);

  const getStreetCruiseRoadPenalty = useCallback((x, y) => {
    if (!streetCruiseRoadRects.length) return 0;
    const pointX = wrapLoopCoordinate(x, stageSize.width);
    let bestScore = Infinity;
    streetCruiseRoadRects.forEach((rect) => {
      [-stageSize.width, 0, stageSize.width].forEach((offset) => {
        const left = rect.x + offset;
        const right = left + rect.w;
        if (pointX < left || pointX > right || y < rect.y || y > rect.y + rect.h) return;
        const centerY = rect.y + rect.h * commercialV2StreetCruiseRoadCenterRatio;
        bestScore = Math.min(
          bestScore,
          Math.abs(y - centerY) * commercialV2StreetCruiseCenterLinePenalty
        );
      });
    });
    return Number.isFinite(bestScore)
      ? bestScore
      : commercialV2StreetCruiseOffRoadPenalty;
  }, [stageSize.width, streetCruiseRoadRects]);

  const getSafePlayerSpawnPoint = useCallback((targetX = commercialV2PlayerInitial.x, targetY = commercialV2PlayerInitial.y) => {
    const targetPointX = wrapLoopCoordinate(targetX, stageSize.width);
    const candidates = [];
    const addCandidate = (x, y) => {
      candidates.push({
        x: wrapLoopCoordinate(x, stageSize.width),
        y
      });
    };
    walkableRects.forEach((rect) => {
      const columns = Math.max(3, Math.min(24, Math.ceil(rect.w / 72)));
      const rows = Math.max(2, Math.min(5, Math.ceil(rect.h / 48)));
      for (let column = 0; column < columns; column += 1) {
        const x = rect.x + ((column + 0.5) / columns) * rect.w;
        for (let row = 0; row < rows; row += 1) {
          const y = rect.y + ((row + 0.5) / rows) * rect.h;
          addCandidate(x, y);
        }
      }
      addCandidate(rect.x + rect.w * 0.5, rect.y + rect.h * 0.55);
      addCandidate(rect.x + rect.w * 0.5, rect.y + rect.h * 0.72);
      addCandidate(rect.x + rect.w * 0.25, rect.y + rect.h * 0.65);
      addCandidate(rect.x + rect.w * 0.75, rect.y + rect.h * 0.65);
    });
    if (!candidates.length) {
      return {
        x: targetPointX,
        y: Math.max(178, Math.min(Math.max(179, stageSize.height - 12), targetY))
      };
    }
    let best = null;
    candidates.forEach((candidate) => {
      if (!isPlayerPositionAllowed(candidate.x, candidate.y, { ignorePlayers: true })) return;
      const rawDx = Math.abs(candidate.x - targetPointX);
      const dx = Math.min(rawDx, Math.max(0, stageSize.width - rawDx));
      const distance = dx ** 2 + (candidate.y - targetY) ** 2;
      if (!best || distance < best.distance) {
        best = { ...candidate, distance };
      }
    });
    if (best) return { x: best.x, y: best.y };
    const largestRoad = walkableRects.reduce((largest, rect) => (
      !largest || rect.w * rect.h > largest.w * largest.h ? rect : largest
    ), null);
    return {
      x: wrapLoopCoordinate((largestRoad?.x ?? targetPointX) + (largestRoad?.w ?? 0) / 2, stageSize.width),
      y: largestRoad ? largestRoad.y + largestRoad.h * 0.6 : targetY
    };
  }, [isPlayerPositionAllowed, stageSize.height, stageSize.width, walkableRects]);

  const buildSafePlayerStates = useCallback((currentPlayers = createCommercialV2PlayerStates()) => {
    const occupiedPoints = [];
    const nextPlayers = {};
    commercialV2PlayerCharacters.forEach((character) => {
      const initial = createCommercialV2PlayerState(character);
      const current = currentPlayers[character.id] || initial;
      const targetOffsets = [0, 72, -72, 128, -128, 196, -196];
      let spawnPoint = null;
      for (const offset of targetOffsets) {
        const candidate = getSafePlayerSpawnPoint(initial.x + offset, initial.y);
        const overlapsExisting = occupiedPoints.some((point) => (
          Math.hypot(
            getCommercialV2LoopDeltaX(point.x, candidate.x, stageSize.width),
            point.y - candidate.y
          ) < 48
        ));
        if (!overlapsExisting) {
          spawnPoint = candidate;
          break;
        }
      }
      spawnPoint = spawnPoint || getSafePlayerSpawnPoint(initial.x, initial.y);
      occupiedPoints.push(spawnPoint);
      nextPlayers[character.id] = {
        ...current,
        ...spawnPoint,
        direction: initial.direction,
        moving: false,
        frame: 0,
        stepTime: 0
      };
    });
    const roleSpawn = nextPlayers[commercialV2RoleActorId];
    const userSpawn = nextPlayers[commercialV2UserActorId];
    if (roleSpawn && userSpawn && isPlayerPositionAllowed(roleSpawn.x, userSpawn.y, { ignorePlayers: true })) {
      roleSpawn.y = userSpawn.y;
    }
    return nextPlayers;
  }, [getSafePlayerSpawnPoint, isPlayerPositionAllowed, stageSize.width]);

  const spawnPlayersOnStage = useCallback((basePlayers = playersRef.current) => {
    const nextPlayers = buildSafePlayerStates(basePlayers);
    playerSpawnedRef.current = true;
    playersRef.current = nextPlayers;
    playerRef.current = nextPlayers[controlledPlayerIdRef.current] || nextPlayers[commercialV2DefaultControlledPlayerId];
    setPlayers(nextPlayers);
  }, [buildSafePlayerStates]);

  const getNearestWalkablePlayerPoint = useCallback((x, y, current = null, options = {}) => {
    const pointOptions = {
      ignorePlayerId: options.ignorePlayerId || current?.id || controlledPlayerIdRef.current,
      ignorePlayers: Boolean(options.ignorePlayers)
    };
    const pointAllowed = options.useAutoTravelBlocks
      ? (pointX, pointY) => isAutoTravelPositionAllowed(pointX, pointY, pointOptions)
      : (pointX, pointY) => isPlayerPositionAllowed(pointX, pointY, pointOptions);
    const approachMinY = Number.isFinite(options.approachMinY) ? Number(options.approachMinY) : null;
    const fallbackToCurrent = options.fallbackToCurrent !== false;
    const fallbackMinY = 178;
    const fallbackMaxY = Math.max(fallbackMinY + 1, stageSize.height - 12);
    const fallbackPoint = current || {
      x: wrapLoopCoordinate(x, stageSize.width),
      y: Math.max(fallbackMinY, Math.min(fallbackMaxY, y))
    };
    if (!walkableRects.length) {
      return pointAllowed(fallbackPoint.x, fallbackPoint.y) ? fallbackPoint : current || fallbackPoint;
    }
    const pointX = wrapLoopCoordinate(x, stageSize.width);
    let best = null;
    let approachBest = null;
    const candidates = [];
    walkableRects.forEach((rect) => {
      [-stageSize.width, 0, stageSize.width].forEach((offset) => {
        const left = rect.x + offset;
        const right = left + rect.w;
        const top = rect.y;
        const bottom = rect.y + rect.h;
        const clampedX = Math.max(left, Math.min(right, pointX));
        const clampedY = Math.max(top, Math.min(bottom, y));
        candidates.push({ x: clampedX, y: clampedY });
        candidates.push({ x: clampedX - 12, y: clampedY });
        candidates.push({ x: clampedX + 12, y: clampedY });
        candidates.push({ x: clampedX, y: clampedY - 12 });
        candidates.push({ x: clampedX, y: clampedY + 12 });
        candidates.push({ x: clampedX, y: top + rect.h * 0.25 });
        candidates.push({ x: clampedX, y: top + rect.h * 0.5 });
        candidates.push({ x: clampedX, y: top + rect.h * 0.75 });
        candidates.push({ x: left, y: clampedY });
        candidates.push({ x: right, y: clampedY });
        candidates.push({ x: clampedX, y: top });
        candidates.push({ x: clampedX, y: bottom });
      });
    });
    candidates.forEach((candidate) => {
      const wrappedX = wrapLoopCoordinate(candidate.x, stageSize.width);
      if (!pointAllowed(wrappedX, candidate.y)) return;
      const distance = (candidate.x - pointX) ** 2 + (candidate.y - y) ** 2;
      if (approachMinY !== null && candidate.y >= approachMinY) {
        const approachDistance = distance + (candidate.y - approachMinY) ** 2 * 0.2;
        if (!approachBest || approachDistance < approachBest.distance) {
          approachBest = { x: wrappedX, y: candidate.y, distance: approachDistance };
        }
      }
      if (!best || distance < best.distance) {
        best = { x: wrappedX, y: candidate.y, distance };
      }
    });
    if (approachBest) return { x: approachBest.x, y: approachBest.y };
    if (best) return { x: best.x, y: best.y };
    if (fallbackToCurrent && current && pointAllowed(current.x, current.y)) return current;
    return getSafePlayerSpawnPoint(pointX, Math.max(fallbackMinY, Math.min(fallbackMaxY, y)));
  }, [getSafePlayerSpawnPoint, isAutoTravelPositionAllowed, isPlayerPositionAllowed, stageSize.width, stageSize.height, walkableRects]);

  const getNearestMainRoadTravelPoint = useCallback((rawX, preferredY = null) => {
    if (!mainRoadRects.length || stageSize.width <= 0) return null;
    const targetX = Number.isFinite(rawX) ? rawX : commercialV2PlayerInitial.x;
    let best = null;
    mainRoadRects.forEach((rect) => {
      [-stageSize.width, 0, stageSize.width].forEach((offset) => {
        const insetX = Math.min(commercialV2MainRoadTargetInset, Math.max(0, rect.w / 2 - 1));
        const insetY = Math.min(20, Math.max(0, rect.h / 2 - 1));
        const left = rect.x + offset + insetX;
        const right = rect.x + offset + rect.w - insetX;
        const top = rect.y + insetY;
        const bottom = rect.y + rect.h - insetY;
        if (right < left || bottom < top) return;
        const clampedX = Math.max(left, Math.min(right, targetX));
        const centerY = rect.y + rect.h * commercialV2MainRoadCenterRatio;
        const preferredRoadY = Number.isFinite(preferredY)
          ? Math.max(top, Math.min(bottom, preferredY))
          : centerY;
        const xSamples = [clampedX, clampedX - 24, clampedX + 24, clampedX - 48, clampedX + 48];
        const ySamples = [centerY, preferredRoadY, centerY - 24, centerY + 24, centerY - 48, centerY + 48];
        xSamples.forEach((candidateX) => {
          if (candidateX < left || candidateX > right) return;
          ySamples.forEach((candidateY) => {
            if (candidateY < top || candidateY > bottom) return;
            const x = wrapLoopCoordinate(candidateX, stageSize.width);
            if (!isAutoTravelPositionAllowed(x, candidateY)) return;
            const score = Math.abs(candidateX - targetX) * 0.8
              + Math.abs(candidateY - centerY) * 2.2
              + Math.abs(candidateY - preferredRoadY) * 0.25;
            if (!best || score < best.score) {
              best = { x, y: candidateY, score };
            }
          });
        });
      });
    });
    return best ? { x: best.x, y: best.y } : null;
  }, [isAutoTravelPositionAllowed, mainRoadRects, stageSize.width]);

  const getNearestStreetCruiseRoadTravelPoint = useCallback((rawX, preferredY = null) => {
    if (!streetCruiseRoadRects.length || stageSize.width <= 0) return null;
    const targetX = Number.isFinite(rawX) ? rawX : commercialV2PlayerInitial.x;
    let best = null;
    streetCruiseRoadRects.forEach((rect) => {
      [-stageSize.width, 0, stageSize.width].forEach((offset) => {
        const insetX = Math.min(commercialV2MainRoadTargetInset, Math.max(0, rect.w / 2 - 1));
        const insetY = Math.min(28, Math.max(0, rect.h / 2 - 1));
        const left = rect.x + offset + insetX;
        const right = rect.x + offset + rect.w - insetX;
        const top = rect.y + insetY;
        const bottom = rect.y + rect.h - insetY;
        if (right < left || bottom < top) return;
        const clampedX = Math.max(left, Math.min(right, targetX));
        const centerY = rect.y + rect.h * commercialV2StreetCruiseRoadCenterRatio;
        const preferredRoadY = Number.isFinite(preferredY)
          ? Math.max(top, Math.min(bottom, preferredY))
          : centerY;
        const xSamples = [clampedX, clampedX - 24, clampedX + 24, clampedX - 48, clampedX + 48];
        const ySamples = [centerY, centerY - 24, centerY + 24, preferredRoadY, centerY - 48, centerY + 48];
        xSamples.forEach((candidateX) => {
          if (candidateX < left || candidateX > right) return;
          ySamples.forEach((candidateY) => {
            if (candidateY < top || candidateY > bottom) return;
            const x = wrapLoopCoordinate(candidateX, stageSize.width);
            if (!isAutoTravelPositionAllowed(x, candidateY)) return;
            const score = Math.abs(candidateX - targetX) * 0.8
              + Math.abs(candidateY - centerY) * 3.6
              + Math.abs(candidateY - preferredRoadY) * 0.05;
            if (!best || score < best.score) {
              best = { x, y: candidateY, score };
            }
          });
        });
      });
    });
    return best ? { x: best.x, y: best.y } : null;
  }, [isAutoTravelPositionAllowed, stageSize.width, streetCruiseRoadRects]);

  const isAutoTravelSegmentClear = useCallback((fromPoint, toPoint) => {
    const dx = getCommercialV2LoopDeltaX(fromPoint.x, toPoint.x, stageSize.width);
    const dy = toPoint.y - fromPoint.y;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(distance / (commercialV2PathCellSize * 0.25)));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = wrapLoopCoordinate(fromPoint.x + dx * ratio, stageSize.width);
      const y = fromPoint.y + dy * ratio;
      if (!isAutoTravelPositionAllowed(x, y)) return false;
    }
    return true;
  }, [isAutoTravelPositionAllowed, stageSize.width]);

  const simplifyAutoTravelPath = useCallback((points) => {
    if (points.length <= 2) return points;
    const simplified = [points[0]];
    let anchorIndex = 0;
    while (anchorIndex < points.length - 1) {
      let nextIndex = anchorIndex + 1;
      for (let candidateIndex = points.length - 1; candidateIndex > nextIndex; candidateIndex -= 1) {
        if (isAutoTravelSegmentClear(points[anchorIndex], points[candidateIndex])) {
          nextIndex = candidateIndex;
          break;
        }
      }
      simplified.push(points[nextIndex]);
      anchorIndex = nextIndex;
    }
    return simplified;
  }, [isAutoTravelSegmentClear]);

  const buildAutoTravelPath = useCallback((fromPoint, targetPoint, options = {}) => {
    if (stageSize.width <= 0 || stageSize.height <= 0) return null;
    const preferMainRoad = Boolean(options.preferMainRoad && mainRoadRects.length);
    const preferStreetCruiseRoad = Boolean(options.preferStreetCruiseRoad && streetCruiseRoadRects.length);
    const preferForward = Boolean(options.preferForward);
    const targetForwardDistance = preferForward
      ? Math.max(commercialV2StreetCruiseMinForward, getCommercialV2LoopDeltaX(fromPoint.x, targetPoint.x, stageSize.width))
      : 0;
    const minForwardProgress = -commercialV2ForwardPathBacktrackLimit;
    const maxForwardProgress = targetForwardDistance + commercialV2ForwardPathOvershootTolerance;
    const getForwardProgress = (point) => getCommercialV2LoopDeltaX(fromPoint.x, point.x, stageSize.width);
    const cellSize = commercialV2PathCellSize;
    const columnCount = Math.max(1, Math.ceil(stageSize.width / cellSize));
    const rowCount = Math.max(1, Math.ceil(stageSize.height / cellSize));
    const cellCount = columnCount * rowCount;
    const allowedCells = new Uint8Array(cellCount);
    const getCellIndex = (column, row) => row * columnCount + column;
    const getCellCenter = (index) => {
      const row = Math.floor(index / columnCount);
      const column = index % columnCount;
      return {
        x: wrapLoopCoordinate(Math.min(stageSize.width - 1, column * cellSize + cellSize / 2), stageSize.width),
        y: Math.min(stageSize.height - 1, row * cellSize + cellSize / 2)
      };
    };
    let allowedCount = 0;
    for (let row = 0; row < rowCount; row += 1) {
      for (let column = 0; column < columnCount; column += 1) {
        const index = getCellIndex(column, row);
        const center = getCellCenter(index);
        if (isAutoTravelPositionAllowed(center.x, center.y)) {
          allowedCells[index] = 1;
          allowedCount += 1;
        }
      }
    }
    if (!allowedCount) return null;

    const findNearestCell = (point, options = {}) => {
      const requireClearSegment = Boolean(options.requireClearSegment);
      let best = null;
      for (let index = 0; index < cellCount; index += 1) {
        if (!allowedCells[index]) continue;
        const center = getCellCenter(index);
        if (preferForward) {
          const progress = getForwardProgress(center);
          if (progress < minForwardProgress || progress > maxForwardProgress) continue;
        }
        if (requireClearSegment && !isAutoTravelSegmentClear(point, center)) continue;
        const dx = getCommercialV2LoopDeltaX(point.x, center.x, stageSize.width);
        const dy = center.y - point.y;
        const score = dx ** 2 + dy ** 2;
        if (!best || score < best.score) {
          best = { index, center, score };
        }
      }
      return best;
    };

    const startCell = findNearestCell(fromPoint, { requireClearSegment: isAutoTravelPositionAllowed(fromPoint.x, fromPoint.y) })
      || findNearestCell(fromPoint);
    const targetCell = findNearestCell(targetPoint, { requireClearSegment: isAutoTravelPositionAllowed(targetPoint.x, targetPoint.y) })
      || findNearestCell(targetPoint);
    if (!startCell || !targetCell) return null;
    if (startCell.index === targetCell.index) {
      const destination = isAutoTravelSegmentClear(fromPoint, targetPoint) ? targetPoint : targetCell.center;
      return {
        destination,
        waypoints: [destination],
        totalDistance: Math.hypot(
          getCommercialV2LoopDeltaX(fromPoint.x, destination.x, stageSize.width),
          destination.y - fromPoint.y
        )
      };
    }

    const getHeuristic = (index) => {
      const current = getCellCenter(index);
      const target = targetCell.center;
      return Math.hypot(
        getCommercialV2LoopDeltaX(current.x, target.x, stageSize.width),
        target.y - current.y
      );
    };
    const gScore = new Float64Array(cellCount);
    gScore.fill(Infinity);
    const cameFrom = new Int32Array(cellCount);
    cameFrom.fill(-1);
    const closedCells = new Uint8Array(cellCount);
    const openHeap = [];
    gScore[startCell.index] = 0;
    pushCommercialV2PathHeap(openHeap, {
      index: startCell.index,
      priority: getHeuristic(startCell.index)
    });

    const directions = [
      { dx: 1, dy: 0, cost: 1 },
      { dx: -1, dy: 0, cost: 1 },
      { dx: 0, dy: 1, cost: 1 },
      { dx: 0, dy: -1, cost: 1 },
      { dx: 1, dy: 1, cost: Math.SQRT2 },
      { dx: 1, dy: -1, cost: Math.SQRT2 },
      { dx: -1, dy: 1, cost: Math.SQRT2 },
      { dx: -1, dy: -1, cost: Math.SQRT2 }
    ];

    let reachedIndex = -1;
    let visitedCount = 0;
    while (openHeap.length && visitedCount < commercialV2PathMaxVisited) {
      const currentNode = popCommercialV2PathHeap(openHeap);
      if (!currentNode || closedCells[currentNode.index]) continue;
      if (currentNode.index === targetCell.index) {
        reachedIndex = currentNode.index;
        break;
      }
      closedCells[currentNode.index] = 1;
      visitedCount += 1;
      const currentRow = Math.floor(currentNode.index / columnCount);
      const currentColumn = currentNode.index % columnCount;
      const currentCenter = getCellCenter(currentNode.index);
      directions.forEach((direction) => {
        const nextRow = currentRow + direction.dy;
        if (nextRow < 0 || nextRow >= rowCount) return;
        const nextColumn = (currentColumn + direction.dx + columnCount) % columnCount;
        const nextIndex = getCellIndex(nextColumn, nextRow);
        if (!allowedCells[nextIndex] || closedCells[nextIndex]) return;
        if (direction.dx && direction.dy) {
          const horizontalIndex = getCellIndex(nextColumn, currentRow);
          const verticalIndex = getCellIndex(currentColumn, nextRow);
          if (!allowedCells[horizontalIndex] || !allowedCells[verticalIndex]) return;
        }
        const nextCenter = getCellCenter(nextIndex);
        if (preferForward) {
          const nextProgress = getForwardProgress(nextCenter);
          if (nextProgress < minForwardProgress || nextProgress > maxForwardProgress) return;
        }
        if (!isAutoTravelSegmentClear(currentCenter, nextCenter)) return;
        const mainRoadPenalty = preferMainRoad && !isMainRoadPoint(nextCenter.x, nextCenter.y)
          ? commercialV2MainRoadCellPenalty
          : 0;
        const streetCruiseRoadPenalty = preferStreetCruiseRoad
          ? getStreetCruiseRoadPenalty(nextCenter.x, nextCenter.y)
          : 0;
        const forwardPenalty = preferForward
          ? Math.max(0, getForwardProgress(currentCenter) - getForwardProgress(nextCenter)) * commercialV2ForwardPathBacktrackPenalty
            + Math.max(0, -getForwardProgress(nextCenter)) * commercialV2ForwardPathBacktrackPenalty
          : 0;
        const tentativeScore = gScore[currentNode.index]
          + direction.cost * cellSize
          + mainRoadPenalty
          + streetCruiseRoadPenalty
          + forwardPenalty;
        if (tentativeScore >= gScore[nextIndex]) return;
        cameFrom[nextIndex] = currentNode.index;
        gScore[nextIndex] = tentativeScore;
        pushCommercialV2PathHeap(openHeap, {
          index: nextIndex,
          priority: tentativeScore + getHeuristic(nextIndex)
        });
      });
    }
    if (reachedIndex < 0) return null;

    const pathIndices = [];
    let cursor = reachedIndex;
    while (cursor >= 0) {
      pathIndices.push(cursor);
      if (cursor === startCell.index) break;
      cursor = cameFrom[cursor];
    }
    pathIndices.reverse();
    const gridPoints = pathIndices.map((index) => getCellCenter(index));
    const rawPoints = [fromPoint];
    const startCenter = gridPoints[0] || startCell.center;
    if (startCenter && Math.hypot(
      getCommercialV2LoopDeltaX(fromPoint.x, startCenter.x, stageSize.width),
      startCenter.y - fromPoint.y
    ) > 2) {
      rawPoints.push(startCenter);
    }
    rawPoints.push(...gridPoints.slice(1));
    const lastGridPoint = rawPoints[rawPoints.length - 1] || fromPoint;
    if (isAutoTravelSegmentClear(lastGridPoint, targetPoint)) {
      rawPoints.push(targetPoint);
    } else if (!rawPoints.length || rawPoints[rawPoints.length - 1] !== targetCell.center) {
      rawPoints.push(targetCell.center);
    }
    const simplifiedPoints = simplifyAutoTravelPath(rawPoints);
    const waypoints = simplifiedPoints.slice(1).filter((point, index, list) => {
      const previous = index === 0 ? fromPoint : list[index - 1];
      return Math.hypot(
        getCommercialV2LoopDeltaX(previous.x, point.x, stageSize.width),
        point.y - previous.y
      ) > 2;
    });
    const finalWaypoints = waypoints.length ? waypoints : [targetCell.center];
    const destination = finalWaypoints[finalWaypoints.length - 1];
    let totalDistance = 0;
    let previous = fromPoint;
    finalWaypoints.forEach((point) => {
      totalDistance += Math.hypot(
        getCommercialV2LoopDeltaX(previous.x, point.x, stageSize.width),
        point.y - previous.y
      );
      previous = point;
    });
    return {
      destination,
      waypoints: finalWaypoints,
      totalDistance
    };
  }, [getStreetCruiseRoadPenalty, isAutoTravelPositionAllowed, isAutoTravelSegmentClear, isMainRoadPoint, mainRoadRects.length, simplifyAutoTravelPath, stageSize.height, stageSize.width, streetCruiseRoadRects.length]);

  const getAutoTravelPropApproachPoint = useCallback((place, currentPlayer) => {
    const item = items.find((candidate) => candidate.id === place?.itemId);
    const asset = item ? assetById.get(item.assetId) : null;
    const collisionBox = item && asset ? getCommercialV2CollisionWorldBox(item, asset) : null;
    if (!place || !collisionBox) return null;
    const anchorX = wrapLoopCoordinate(place.anchor.x, stageSize.width);
    const anchorY = place.anchor.y;
    const footWidth = Math.max(12, playerDimensions.width * 0.28);
    const footHeight = Math.max(8, playerDimensions.footOffset * 0.75);
    const upperProbeHeight = Math.max(8, Math.min(26, playerDimensions.footOffset * 1.6));
    const northClearance = Math.max(18, footHeight / 2 + 2);
    const southClearance = Math.max(18, upperProbeHeight + footHeight / 2 + 2);
    const sideClearance = Math.max(18, footWidth / 2 + 2);
    const xSamples = [
      anchorX,
      collisionBox.x + collisionBox.w * 0.5,
      collisionBox.x + collisionBox.w * 0.25,
      collisionBox.x + collisionBox.w * 0.75
    ];
    const ySamples = [
      anchorY,
      collisionBox.y + collisionBox.h * 0.5,
      collisionBox.y + collisionBox.h * 0.25,
      collisionBox.y + collisionBox.h * 0.75
    ];
    const sideOrderByFacing = {
      front: ['north', 'west', 'east', 'south'],
      back: ['south', 'west', 'east', 'north'],
      left: ['east', 'north', 'south', 'west'],
      right: ['west', 'north', 'south', 'east']
    };
    const sideOrder = sideOrderByFacing[place.facing] || sideOrderByFacing.back;
    const candidates = [];
    const getPointSide = (x, y) => {
      if (y <= collisionBox.y) return 'north';
      if (y >= collisionBox.y + collisionBox.h) return 'south';
      const dxLeft = Math.abs(getCommercialV2LoopDeltaX(x, collisionBox.x, stageSize.width));
      const dxRight = Math.abs(getCommercialV2LoopDeltaX(x, collisionBox.x + collisionBox.w, stageSize.width));
      return dxLeft <= dxRight ? 'west' : 'east';
    };
    const addCandidate = (x, y, side) => {
      candidates.push({
        x: wrapLoopCoordinate(x, stageSize.width),
        y,
        side
      });
    };
    const anchorSide = getPointSide(anchorX, anchorY);
    if (place.manualAnchor || anchorSide === sideOrder[0]) {
      addCandidate(anchorX, anchorY, anchorSide);
    }
    xSamples.forEach((x) => {
      addCandidate(x, collisionBox.y - northClearance, 'north');
      addCandidate(x, collisionBox.y + collisionBox.h + southClearance, 'south');
    });
    ySamples.forEach((y) => {
      addCandidate(collisionBox.x - sideClearance, y, 'west');
      addCandidate(collisionBox.x + collisionBox.w + sideClearance, y, 'east');
    });
    [28, 48, 72, 96].forEach((radius) => {
      for (let step = 0; step < 16; step += 1) {
        const angle = (Math.PI * 2 * step) / 16;
        addCandidate(anchorX + Math.cos(angle) * radius, anchorY + Math.sin(angle) * radius, 'ring');
      }
    });
    let best = null;
    candidates.forEach((candidate) => {
      if (candidate.y < 0 || candidate.y > stageSize.height - 4) return;
      if (!isAutoTravelPositionAllowed(candidate.x, candidate.y)) return;
      const sideRank = sideOrder.includes(candidate.side)
        ? sideOrder.indexOf(candidate.side)
        : sideOrder.length;
      const anchorDistance = Math.hypot(
        getCommercialV2LoopDeltaX(anchorX, candidate.x, stageSize.width),
        candidate.y - anchorY
      );
      const currentDistance = currentPlayer ? Math.hypot(
        getCommercialV2LoopDeltaX(currentPlayer.x, candidate.x, stageSize.width),
        candidate.y - currentPlayer.y
      ) : 0;
      const score = sideRank * 10000 + anchorDistance + currentDistance * 0.05;
      if (!best || score < best.score) {
        best = { ...candidate, score };
      }
    });
    return best ? { x: best.x, y: best.y } : null;
  }, [assetById, isAutoTravelPositionAllowed, items, playerDimensions.footOffset, playerDimensions.width, stageSize.height, stageSize.width]);

  const getAutoTravelTargetPoint = useCallback((place, currentPlayer) => {
    if (!place) return null;
    const approachMinY = getCommercialV2PlaceApproachMinY(place);
    if (place.manualAnchor) {
      if (approachMinY === null) {
        const propApproachPoint = getAutoTravelPropApproachPoint(place, currentPlayer);
        if (propApproachPoint) return propApproachPoint;
      }
      return getNearestWalkablePlayerPoint(place.anchor.x, place.anchor.y, currentPlayer, {
        useAutoTravelBlocks: true,
        fallbackToCurrent: false
      });
    }
    if (approachMinY === null) {
      const propApproachPoint = getAutoTravelPropApproachPoint(place, currentPlayer);
      if (propApproachPoint) return propApproachPoint;
      return getNearestWalkablePlayerPoint(place.anchor.x, place.anchor.y, currentPlayer, {
        useAutoTravelBlocks: true,
        fallbackToCurrent: false
      });
    }
    const desiredX = wrapLoopCoordinate(place.anchor.x, stageSize.width);
    const buildingApproachOffset = place.assetId === 'building_hospital'
      ? Math.max(96, playerDimensions.height * 0.68)
      : Math.max(54, playerDimensions.height * 0.42);
    const desiredY = Math.max(0, Math.min(stageSize.height - 8, place.anchor.y + buildingApproachOffset));
    const xOffsets = [0, -12, 12, -24, 24, -36, 36, -48, 48, -72, 72, -96, 96, -132, 132, -168, 168];
    const yOffsets = [0, 12, 24, 36, 48, 64, 80, 104, 128, -12, -24, -36];
    let best = null;
    yOffsets.forEach((dy) => {
      const y = desiredY + dy;
      if (y < approachMinY || y < 0 || y > stageSize.height - 4) return;
      xOffsets.forEach((dx) => {
        const x = wrapLoopCoordinate(desiredX + dx, stageSize.width);
        if (!isAutoTravelPositionAllowed(x, y)) return;
        const score = Math.abs(dx) * 2.2 + Math.abs(dy) + Math.max(0, y - desiredY) * 0.35;
        if (!best || score < best.score) {
          best = { x, y, score };
        }
      });
    });
    if (best) return { x: best.x, y: best.y };
    const fallback = getNearestWalkablePlayerPoint(place.anchor.x, place.anchor.y, currentPlayer, {
      useAutoTravelBlocks: true,
      fallbackToCurrent: false,
      approachMinY
    });
    return fallback && fallback.y >= approachMinY ? fallback : null;
  }, [getAutoTravelPropApproachPoint, getNearestWalkablePlayerPoint, isAutoTravelPositionAllowed, playerDimensions.height, stageSize.height, stageSize.width]);

  const cancelAutoTravel = useCallback((message = '') => {
    const travelPlayerId = autoTravelRef.current?.playerId || controlledPlayerIdRef.current;
    autoTravelRef.current = null;
    setAutoTravelActive(false);
    setPlayerActionBubble('');
    setPlayerActionBubbles((current) => {
      if (!current[travelPlayerId]) return current;
      const next = { ...current };
      delete next[travelPlayerId];
      return next;
    });
    if (message) setNotice(message);
  }, []);

  const switchControlledPlayer = useCallback((nextPlayerId) => {
    const character = commercialV2PlayerCharacterById.get(nextPlayerId);
    if (!character || nextPlayerId === controlledPlayerIdRef.current) return;
    pressedKeysRef.current.clear();
    cancelAutoTravel();
    controlledPlayerIdRef.current = nextPlayerId;
    playerRef.current = playersRef.current[nextPlayerId] || createCommercialV2PlayerState(character);
    setControlledPlayerId(nextPlayerId);
    setNotice(`现在控制：${character.label}。WASD 会移动当前选中的人物。`);
  }, [cancelAutoTravel]);

  const buildStreetCruiseSegment = useCallback((fromPoint) => {
    if (!fromPoint || stageSize.width <= 0 || stageSize.height <= 0) return null;
    const origin = {
      x: wrapLoopCoordinate(Number.isFinite(fromPoint.x) ? fromPoint.x : commercialV2PlayerInitial.x, stageSize.width),
      y: Number.isFinite(fromPoint.y) ? fromPoint.y : commercialV2PlayerInitial.y
    };
    const minY = 178;
    const maxY = Math.max(minY + 1, stageSize.height - 12);
    const baseY = Math.max(minY, Math.min(maxY, origin.y));
    const isAcceptableCruiseRoute = (route) => {
      if (!route?.waypoints?.length) return false;
      const routeForwardDelta = getCommercialV2LoopDeltaX(origin.x, route.destination.x, stageSize.width);
      if (routeForwardDelta < commercialV2StreetCruiseMinForward) return false;
      const minProgress = route.waypoints.reduce((minimum, point) => (
        Math.min(minimum, getCommercialV2LoopDeltaX(origin.x, point.x, stageSize.width))
      ), routeForwardDelta);
      const maxProgress = route.waypoints.reduce((maximum, point) => (
        Math.max(maximum, getCommercialV2LoopDeltaX(origin.x, point.x, stageSize.width))
      ), routeForwardDelta);
      return minProgress >= -commercialV2ForwardPathBacktrackLimit * 2
        && maxProgress <= routeForwardDelta + commercialV2ForwardPathOvershootTolerance * 2;
    };
    const buildStreetCruiseRoadCenterRoute = (candidate) => {
      if (!streetCruiseRoadRects.length || !isStreetCruiseRoadPoint(candidate.x, candidate.y)) return null;
      const finalProgress = getCommercialV2LoopDeltaX(origin.x, candidate.x, stageSize.width);
      if (finalProgress < commercialV2StreetCruiseMinForward) return null;
      const distances = [0];
      for (
        let distance = commercialV2StreetCruiseCenterStep;
        distance < finalProgress;
        distance += commercialV2StreetCruiseCenterStep
      ) {
        distances.push(distance);
      }
      distances.push(finalProgress);
      const centerPoints = [];
      let preferredY = baseY;
      distances.forEach((distance, index) => {
        const point = index === distances.length - 1
          ? candidate
          : getNearestStreetCruiseRoadTravelPoint(origin.x + distance, preferredY);
        if (!point) return;
        const previous = centerPoints[centerPoints.length - 1] || origin;
        const progress = getCommercialV2LoopDeltaX(origin.x, point.x, stageSize.width);
        const previousProgress = getCommercialV2LoopDeltaX(origin.x, previous.x, stageSize.width);
        const duplicate = Math.hypot(
          getCommercialV2LoopDeltaX(previous.x, point.x, stageSize.width),
          previous.y - point.y
        ) < 8;
        if (duplicate || progress < previousProgress - 8) return;
        centerPoints.push(point);
        preferredY = point.y;
      });
      if (!centerPoints.length) return null;
      const waypoints = [];
      let totalDistance = 0;
      let previous = origin;
      for (const point of centerPoints) {
        const forwardDelta = getCommercialV2LoopDeltaX(previous.x, point.x, stageSize.width);
        const segment = buildAutoTravelPath(previous, point, {
          preferStreetCruiseRoad: true,
          preferForward: forwardDelta >= commercialV2StreetCruiseMinForward
        });
        if (!segment?.waypoints?.length) return null;
        segment.waypoints.forEach((waypoint) => {
          const last = waypoints[waypoints.length - 1] || previous;
          const distance = Math.hypot(
            getCommercialV2LoopDeltaX(last.x, waypoint.x, stageSize.width),
            waypoint.y - last.y
          );
          if (distance < 2) return;
          waypoints.push(waypoint);
          totalDistance += distance;
        });
        previous = segment.destination;
      }
      return {
        destination: waypoints[waypoints.length - 1] || centerPoints[centerPoints.length - 1],
        waypoints,
        totalDistance
      };
    };
    const buildCruiseRoute = (candidate) => {
      const centerRoute = buildStreetCruiseRoadCenterRoute(candidate);
      if (isAcceptableCruiseRoute(centerRoute)) return centerRoute;
      const attempts = [
        { preferStreetCruiseRoad: isStreetCruiseRoadPoint(candidate.x, candidate.y), preferForward: true },
        { preferMainRoad: isMainRoadPoint(candidate.x, candidate.y), preferForward: true },
        { preferMainRoad: false, preferForward: true },
        { preferMainRoad: false, preferForward: false }
      ];
      for (const routeOptions of attempts) {
        const route = buildAutoTravelPath(origin, candidate, routeOptions);
        if (isAcceptableCruiseRoute(route)) return route;
      }
      return null;
    };
    for (const distance of commercialV2StreetCruiseDistances) {
      for (const laneOffset of commercialV2StreetCruiseLaneOffsets) {
        const candidate = getNearestStreetCruiseRoadTravelPoint(origin.x + distance, baseY + laneOffset)
          || getNearestMainRoadTravelPoint(origin.x + distance, baseY + laneOffset)
          || getNearestWalkablePlayerPoint(
            origin.x + distance,
            baseY + laneOffset,
            origin,
            {
              useAutoTravelBlocks: true,
              fallbackToCurrent: false
            }
          );
        if (!candidate) continue;
        const forwardDelta = getCommercialV2LoopDeltaX(origin.x, candidate.x, stageSize.width);
        if (forwardDelta < commercialV2StreetCruiseMinForward) continue;
        const route = buildCruiseRoute(candidate);
        if (!route) continue;
        return {
          ...route,
          anchorPoint: candidate
        };
      }
    }
    return null;
  }, [buildAutoTravelPath, getNearestMainRoadTravelPoint, getNearestStreetCruiseRoadTravelPoint, getNearestWalkablePlayerPoint, isMainRoadPoint, isStreetCruiseRoadPoint, stageSize.height, stageSize.width, streetCruiseRoadRects.length]);

  const resolveStreetCruiseTarget = useCallback((currentPlayer = playerRef.current) => {
    const route = buildStreetCruiseSegment(currentPlayer);
    if (!route?.waypoints?.length) return null;
    return {
      targetId: 'street',
      mode: 'streetCruise',
      place: { facing: 'right' },
      point: route.destination,
      anchorPoint: route.anchorPoint,
      path: route.waypoints,
      score: route.totalDistance,
      label: commercialV2TravelLabelById.street,
      action: '闲逛中'
    };
  }, [buildStreetCruiseSegment]);

  const resolveAutoTravelTarget = useCallback((targetId, currentPlayerOverride = null) => {
    const requestedId = String(targetId || '').trim();
    if (!requestedId) return null;
    const currentPlayer = currentPlayerOverride || playerRef.current;
    if (requestedId === 'street') {
      return resolveStreetCruiseTarget(currentPlayer);
    }
    const exactPlaceCandidates = placeLinks.filter((place) => place.placeId === requestedId);
    const exactLocationCandidates = exactPlaceCandidates.length ? [] : placeLinks.filter((place) => place.locationId === requestedId);
    const candidates = exactPlaceCandidates.length
      ? exactPlaceCandidates
      : (exactLocationCandidates.length
        ? exactLocationCandidates
        : placeLinks.filter((place) => place.locationIds.includes(requestedId)));
    if (!candidates.length) return null;
    let best = null;
    candidates.forEach((place) => {
      const point = getAutoTravelTargetPoint(place, currentPlayer);
      if (!point) return;
      const route = buildAutoTravelPath(currentPlayer, point);
      if (!route?.waypoints?.length) return;
      const score = route.totalDistance;
      if (!best || score < best.score) {
        best = {
          targetId: requestedId,
          place,
          point: route.destination,
          anchorPoint: point,
          path: route.waypoints,
          score,
          label: commercialV2TravelLabelById[requestedId] || place.name,
          action: getCommercialV2TravelAction(place, requestedId)
        };
      }
    });
    return best;
  }, [buildAutoTravelPath, getAutoTravelTargetPoint, placeLinks, resolveStreetCruiseTarget]);

  const startAutoTravel = useCallback((targetId = autoTargetId) => {
    const playerId = controlledPlayerIdRef.current;
    const target = resolveAutoTravelTarget(targetId, playerRef.current);
    if (!target) {
      setNotice('这个地点现在没有可用锚点或绕行路线，先检查地点锚点和碰撞箱。');
      return;
    }
    pressedKeysRef.current.clear();
    autoTravelRef.current = {
      ...target,
      playerId,
      pathIndex: 0,
      stuckTime: 0,
      lastX: playerRef.current.x,
      lastY: playerRef.current.y
    };
    setAutoTargetId(target.targetId);
    setAutoTravelActive(true);
    if (target.mode === 'streetCruise') {
      setPlayerActionBubble(`逛 ${target.label}`);
      setNotice(`沿 ${target.label} 往前走，已规划 ${target.path.length} 个绕行点。`);
      return;
    }
    setPlayerActionBubble(`去 ${target.label}`);
    setNotice(`自动前往 ${target.label}，已规划 ${target.path.length} 个绕行点。`);
  }, [autoTargetId, resolveAutoTravelTarget]);

  function getBehaviorStepPlaceId(step) {
    return String(step?.place_id || step?.to_place_id || step?.target_place_id || step?.placeId || step?.toPlaceId || '').trim();
  }

  function buildBehaviorSmoothTravelPath(fromPoint, toPoint) {
    if (!fromPoint || !toPoint) return [];
    const targetPoint = {
      x: wrapLoopCoordinate(Number.isFinite(toPoint.x) ? toPoint.x : fromPoint.x, stageSize.width),
      y: Number.isFinite(toPoint.y) ? toPoint.y : fromPoint.y
    };
    const dx = getCommercialV2LoopDeltaX(fromPoint.x, targetPoint.x, stageSize.width);
    const dy = targetPoint.y - fromPoint.y;
    if (Math.hypot(dx, dy) < 4) return [targetPoint];
    if (Math.abs(dx) < 36 || Math.abs(dy) > Math.abs(dx) * 0.55) {
      return [targetPoint];
    }
    const laneY = Math.round(fromPoint.y + dy * 0.32);
    const midPoint = {
      x: wrapLoopCoordinate(fromPoint.x + dx * 0.5, stageSize.width),
      y: laneY
    };
    return [
      midPoint,
      { x: targetPoint.x, y: laneY },
      targetPoint
    ];
  }

  function activateBehaviorBranch(branch, source = 'ai') {
    if (!branch || !Array.isArray(branch.steps) || !branch.steps.length) return;
    const now = Date.now();
    if (autoTravelRef.current?.behaviorRuntimeId) {
      autoTravelRef.current = null;
      setAutoTravelActive(false);
    }
    const ttl = Math.max(3000, Math.min(Number(branch.ttl_ms || branch.ttlMs) || 45000, 120000));
    const runtime = {
      id: `${branch.branch_id || branch.id || 'branch'}_${now}`,
      source,
      branch,
      stepIndex: 0,
      waitingUntil: 0,
      waitingForTravelId: '',
      expiresAt: now + ttl,
      startedAt: now
    };
    behaviorRuntimeRef.current = runtime;
    const branchKindLabel = source === 'base' || branch.branch_kind === 'base'
      ? '基础枝丫'
      : '特殊枝丫';
    const activeNodeId = branch.branch_id || branch.id || runtime.id;
    setBehaviorTreeState((currentTree) => ({
      ...currentTree,
      active_node_id: activeNodeId,
      memory: {
        ...(currentTree.memory || {}),
        last_active_node_id: activeNodeId,
        last_active_source: source
      }
    }));
    setActiveBehaviorBranch({
      branch_id: activeNodeId,
      title: branch.title || branchKindLabel,
      summary: branch.summary || '',
      branchKindLabel,
      source,
      stepIndex: 0,
      totalSteps: branch.steps.length,
      expiresAt: runtime.expiresAt
    });
    setActiveBehaviorDialog(null);
    setInteractionMenuOpen(false);
    setWorldPlayerBubble(commercialV2RoleActorId, branch.title || branchKindLabel);
    setNotice(`${branchKindLabel}开始执行：${branch.title || branch.branch_id || '未命名'}。`);
  }

  function clearBehaviorRuntime(message = '') {
    behaviorRuntimeRef.current = null;
    if (autoTravelRef.current?.behaviorRuntimeId) {
      autoTravelRef.current = null;
      setAutoTravelActive(false);
    }
    setActiveBehaviorBranch(null);
    setActiveBehaviorDialog((current) => current?.type === 'pending' ? current : null);
    setWorldPlayerBubble(commercialV2RoleActorId, '');
    if (message) setNotice(message);
  }

  function startBehaviorTravelStep(runtime, step) {
    const action = String(step?.action || '');
    let targetId = getBehaviorStepPlaceId(step);
    if ((action === 'approach_player' || action === 'follow_player') && !targetId) {
      const role = playersRef.current[commercialV2RoleActorId] || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2RoleActorId));
      const user = playersRef.current[commercialV2UserActorId] || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2UserActorId));
      const dx = getCommercialV2LoopDeltaX(role.x, user.x, stageSize.width);
      const targetPoint = getNearestWalkablePlayerPoint(user.x - Math.sign(dx || 1) * 58, user.y, role, {
        useAutoTravelBlocks: true,
        fallbackToCurrent: false
      });
      const route = targetPoint ? buildAutoTravelPath(role, targetPoint) : null;
      const smoothPath = buildBehaviorSmoothTravelPath(role, targetPoint);
      if (!smoothPath.length && !route?.waypoints?.length) return false;
      const travelId = `${runtime.id}_step_${runtime.stepIndex}`;
      autoTravelRef.current = {
        targetId: 'player',
        playerId: commercialV2RoleActorId,
        behaviorRuntimeId: runtime.id,
        behaviorTravelId: travelId,
        place: { facing: dx > 0 ? 'right' : 'left' },
        point: smoothPath[smoothPath.length - 1] || route.destination,
        anchorPoint: targetPoint,
        path: smoothPath.length ? smoothPath : route.waypoints,
        semanticSlide: true,
        pathIndex: 0,
        stuckTime: 0,
        lastX: role.x,
        lastY: role.y,
        label: '玩家',
        action: action === 'follow_player' ? '跟随玩家' : '靠近玩家'
      };
      runtime.waitingForTravelId = travelId;
      setAutoTravelActive(true);
      setWorldPlayerBubble(commercialV2RoleActorId, action === 'follow_player' ? '跟上你' : '靠近你');
      return true;
    }
    if (!targetId) return false;
    const role = playersRef.current[commercialV2RoleActorId] || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2RoleActorId));
    const target = resolveAutoTravelTarget(targetId, role);
    if (!target) return false;
    const travelId = `${runtime.id}_step_${runtime.stepIndex}`;
    const targetPoint = target.anchorPoint || target.point;
    const smoothPath = buildBehaviorSmoothTravelPath(role, targetPoint);
    autoTravelRef.current = {
      ...target,
      playerId: commercialV2RoleActorId,
      behaviorRuntimeId: runtime.id,
      behaviorTravelId: travelId,
      point: smoothPath[smoothPath.length - 1] || target.point,
      path: smoothPath.length ? smoothPath : target.path,
      semanticSlide: true,
      pathIndex: 0,
      stuckTime: 0,
      lastX: role.x,
      lastY: role.y,
      action: step?.movement_style || target.action || '行动中'
    };
    runtime.waitingForTravelId = travelId;
    setAutoTravelActive(true);
    setWorldPlayerBubble(commercialV2RoleActorId, target.label ? `去 ${target.label}` : '行动中');
    return true;
  }

  function advanceBehaviorRuntime() {
    const runtime = behaviorRuntimeRef.current;
    if (!runtime?.branch) return;
    const now = Date.now();
    if ((runtime.waitingForDialog || runtime.waitingForChoice) && now > runtime.expiresAt - 10000) {
      runtime.expiresAt = now + 60000;
    }
    if (now > runtime.expiresAt) {
      const label = runtime.source === 'base' || runtime.branch.branch_kind === 'base' ? '基础枝丫' : '特殊枝丫';
      clearBehaviorRuntime(`${label}已过期：${runtime.branch.title || runtime.branch.branch_id || '未命名'}。`);
      return;
    }
    if (runtime.waitingForDialog || runtime.waitingForChoice) return;
    if (runtime.waitingUntil && now < runtime.waitingUntil) return;
    if (runtime.waitingForTravelId) {
      if (autoTravelRef.current?.behaviorTravelId === runtime.waitingForTravelId) return;
      runtime.waitingForTravelId = '';
      runtime.stepIndex += 1;
    }
    const steps = runtime.branch.steps || [];
    if (runtime.stepIndex >= steps.length) {
      const label = runtime.source === 'base' || runtime.branch.branch_kind === 'base' ? '基础枝丫' : '特殊枝丫';
      clearBehaviorRuntime(`${label}执行完毕：${runtime.branch.title || runtime.branch.branch_id || '未命名'}。`);
      return;
    }
    const step = steps[runtime.stepIndex] || {};
    const action = String(step.action || '').trim();
    setActiveBehaviorBranch((current) => current ? {
      ...current,
      stepIndex: runtime.stepIndex,
      totalSteps: steps.length,
      currentAction: action
    } : current);
    if (action === 'say' || action === 'emote') {
      const isBaseBranch = runtime.source === 'base' || runtime.branch.branch_kind === 'base';
      if (isBaseBranch) {
        const text = String(step.text || (action === 'say' ? '……' : '停顿了一下')).trim();
        setWorldPlayerBubble(commercialV2RoleActorId, text);
        setBehaviorStatus(action === 'say' ? `基础枝丫气泡：${text}` : `基础枝丫动作：${text}`);
        const requestedDuration = Number(step.duration_ms || step.durationMs);
        const readableDuration = Math.min(5200, 1600 + text.length * 85);
        runtime.waitingUntil = now + Math.max(1200, Math.min(Number.isFinite(requestedDuration) ? requestedDuration : readableDuration, 5200));
        runtime.stepIndex += 1;
        return;
      }
      runtime.waitingForDialog = true;
      runtime.waitingUntil = 0;
      setWorldPlayerBubble(commercialV2RoleActorId, '');
      setInteractionMenuOpen(false);
      setActiveBehaviorDialog({
        runtimeId: runtime.id,
        type: action,
        title: action === 'say' ? (behaviorCharacter?.name || '角色') : '动作',
        text: String(step.text || (action === 'say' ? '……' : '停顿了一下')).trim(),
        stepIndex: runtime.stepIndex,
        totalSteps: steps.length
      });
      setBehaviorStatus(action === 'say' ? '行为树等待：点击“下一句”继续角色台词。' : '行为树等待：点击“下一句”继续角色动作。');
      return;
    }
    if (action === 'wait') {
      const isBaseBranch = runtime.source === 'base' || runtime.branch.branch_kind === 'base';
      runtime.waitingUntil = isBaseBranch
        ? now + Math.max(220, Math.min(Number(step.duration_ms || step.durationMs) || commercialV2BehaviorBaseWaitMs, commercialV2BehaviorBaseWaitMs))
        : now + Math.max(300, Math.min(Number(step.duration_ms || step.durationMs) || 900, 6000));
      runtime.stepIndex += 1;
      return;
    }
    if (action === 'face_player') {
      const role = playersRef.current[commercialV2RoleActorId] || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2RoleActorId));
      const user = playersRef.current[commercialV2UserActorId] || createCommercialV2PlayerState(commercialV2PlayerCharacterById.get(commercialV2UserActorId));
      const dx = getCommercialV2LoopDeltaX(role.x, user.x, stageSize.width);
      const dy = user.y - role.y;
      const direction = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'front' : 'back');
      setPlayerById(commercialV2RoleActorId, (current) => ({
        ...current,
        direction,
        moving: false,
        frame: 0
      }));
      runtime.waitingUntil = now + 350;
      runtime.stepIndex += 1;
      return;
    }
    if (
      action === 'go_to_place'
      || action === 'walk_with_player'
      || action === 'idle_at_place'
      || action === 'browse_near'
      || action === 'loop_in_front_of'
      || action === 'wander_between'
      || action === 'patrol_segment'
      || action === 'approach_player'
      || action === 'follow_player'
    ) {
      const moved = startBehaviorTravelStep(runtime, step);
      if (!moved) {
        setWorldPlayerBubble(commercialV2RoleActorId, step.movement_style || action);
        const isBaseBranch = runtime.source === 'base' || runtime.branch.branch_kind === 'base';
        runtime.waitingUntil = now + (isBaseBranch ? commercialV2BehaviorBaseFallbackMs : 1200);
        runtime.stepIndex += 1;
      }
      return;
    }
    if (action === 'offer_choices') {
      const choices = normalizeBehaviorDialogChoices(step.choices);
      runtime.waitingForChoice = true;
      runtime.waitingUntil = 0;
      setWorldPlayerBubble(commercialV2RoleActorId, '');
      setInteractionMenuOpen(false);
      setActiveBehaviorDialog({
        runtimeId: runtime.id,
        type: 'choice',
        title: behaviorCharacter?.name || '角色',
        text: String(step.text || '你要怎么回应？').trim(),
        choices,
        stepIndex: runtime.stepIndex,
        totalSteps: steps.length
      });
      setBehaviorStatus('行为树等待：请选择玩家回应。');
      return;
    }
    runtime.stepIndex += 1;
  }

  pickAutonomousBehaviorBranchRef.current = pickAutonomousBehaviorBranch;
  activateBehaviorBranchRef.current = activateBehaviorBranch;
  advanceBehaviorRuntimeRef.current = advanceBehaviorRuntime;

  useEffect(() => {
    if (playerSpawnedRef.current) return;
    spawnPlayersOnStage(playersRef.current);
  }, [spawnPlayersOnStage]);

  const resolvePlayerGroundMove = useCallback((current, nextX, nextY, options = {}) => {
    const useAutoTravelBlocks = Boolean(options.useAutoTravelBlocks);
    const pointOptions = { ignorePlayerId: current?.id || controlledPlayerIdRef.current };
    const pointAllowed = useAutoTravelBlocks
      ? (pointX, pointY) => isAutoTravelPositionAllowed(pointX, pointY, pointOptions)
      : (pointX, pointY) => isPlayerPositionAllowed(pointX, pointY, pointOptions);
    const wrappedNextX = wrapLoopCoordinate(nextX, stageSize.width);
    if (pointAllowed(wrappedNextX, nextY)) {
      return { x: wrappedNextX, y: nextY };
    }
    if (pointAllowed(wrappedNextX, current.y)) {
      return { x: wrappedNextX, y: current.y };
    }
    if (pointAllowed(current.x, nextY)) {
      return { x: current.x, y: nextY };
    }
    if (pointAllowed(current.x, current.y)) {
      return { x: current.x, y: current.y };
    }
    return getNearestWalkablePlayerPoint(wrappedNextX, nextY, current, { useAutoTravelBlocks, ...pointOptions });
  }, [getNearestWalkablePlayerPoint, isAutoTravelPositionAllowed, isPlayerPositionAllowed, stageSize.width]);

  const centerPlayerInView = useCallback((instant = true) => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const panelWidth = stageSize.width * zoom;
    const currentViewportCenter = wrap.scrollLeft + wrap.clientWidth / 2;
    const playerCenterOptions = [
      player.x * zoom,
      panelWidth + player.x * zoom,
      panelWidth * 2 + player.x * zoom
    ];
    const playerCenterX = playerCenterOptions.reduce((closest, option) => (
      Math.abs(option - currentViewportCenter) < Math.abs(closest - currentViewportCenter) ? option : closest
    ));
    const playerCenterY = (player.y - (playerDimensions.height - playerDimensions.footOffset) / 2) * zoom;
    const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    const targetLeft = Math.max(0, Math.min(maxLeft, playerCenterX - wrap.clientWidth / 2));
    const targetTop = Math.max(0, Math.min(maxTop, playerCenterY - wrap.clientHeight / 2));
    if (instant) {
      wrap.scrollLeft = targetLeft;
      wrap.scrollTop = targetTop;
      return;
    }
    wrap.scrollLeft += (targetLeft - wrap.scrollLeft) * 0.34;
    wrap.scrollTop += (targetTop - wrap.scrollTop) * 0.34;
  }, [player.x, player.y, playerDimensions.height, playerDimensions.footOffset, stageSize.width, zoom]);

  useEffect(() => {
    setPlayers((currentPlayers) => {
      let changed = false;
      const nextPlayers = {};
      commercialV2PlayerCharacters.forEach((character) => {
        const current = currentPlayers[character.id] || createCommercialV2PlayerState(character);
        if (isPlayerPositionAllowed(current.x, current.y)) {
          nextPlayers[character.id] = current;
          return;
        }
        const groundedPoint = getNearestWalkablePlayerPoint(current.x, current.y, current);
        nextPlayers[character.id] = {
          ...current,
          ...groundedPoint,
          moving: false,
          frame: 0,
          stepTime: 0
        };
        changed = true;
      });
      return changed ? nextPlayers : currentPlayers;
    });
  }, [getNearestWalkablePlayerPoint, isPlayerPositionAllowed]);

  useEffect(() => {
    const pressedKeys = pressedKeysRef.current;
    const isTypingTarget = (target) => {
      const tagName = target?.tagName?.toLowerCase();
      return target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
    };
    const getKeyVector = (key) => {
      if (key === 'a' || key === 'arrowleft') return { dx: -1, dy: 0 };
      if (key === 'd' || key === 'arrowright') return { dx: 1, dy: 0 };
      if (key === 'w' || key === 'arrowup') return { dx: 0, dy: -1 };
      if (key === 's' || key === 'arrowdown') return { dx: 0, dy: 1 };
      return null;
    };
    const getDirection = (dx, dy) => (
      Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'front' : 'back')
    );
    const nudgePlayer = (dx, dy) => {
      const direction = getDirection(dx, dy);
      setPlayer((current) => ({
        ...current,
        ...resolvePlayerGroundMove(current, current.x + dx * 12, current.y + dy * 12),
        direction,
        moving: true,
        frame: 1,
        stepTime: current.stepTime + 0.14
      }));
    };
    const onKeyDown = (event) => {
      const key = event.key.toLowerCase();
      if (!commercialV2MovementKeys.has(key) || isTypingTarget(event.target)) return;
      if (!autoTravelRef.current?.playerId || autoTravelRef.current.playerId === controlledPlayerIdRef.current) {
        cancelAutoTravel('已切回手动控制。');
      }
      const wasPressed = pressedKeys.has(key);
      pressedKeys.add(key);
      const vector = getKeyVector(key);
      if (!wasPressed && vector) nudgePlayer(vector.dx, vector.dy);
      event.preventDefault();
    };
    const onKeyUp = (event) => {
      const key = event.key.toLowerCase();
      if (!commercialV2MovementKeys.has(key)) return;
      pressedKeys.delete(key);
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      pressedKeys.clear();
    };
  }, [cancelAutoTravel, resolvePlayerGroundMove, setPlayer]);

  useEffect(() => {
    let frameId = 0;
    let previousTime = performance.now();
    const stepConcurrentAutoTravel = (delta) => {
      const travel = autoTravelRef.current;
      if (!travel?.playerId || travel.playerId === controlledPlayerIdRef.current) return;
      const travelPlayerId = travel.playerId;
      const travelCharacter = commercialV2PlayerCharacterById.get(travelPlayerId) || commercialV2PlayerCharacters[0];
      const currentPlayer = playersRef.current[travelPlayerId] || createCommercialV2PlayerState(travelCharacter);
      const path = travel.path?.length ? travel.path : [travel.point];
      let waypointIndex = Math.min(travel.pathIndex || 0, path.length - 1);
      let waypoint = path[waypointIndex] || travel.point;
      let targetDx = getCommercialV2LoopDeltaX(currentPlayer.x, waypoint.x, stageSize.width);
      let targetDy = waypoint.y - currentPlayer.y;
      let distance = Math.hypot(targetDx, targetDy);
      const waypointReach = travel.behaviorRuntimeId ? Math.max(5, commercialV2PathWaypointReach * 0.65) : commercialV2PathWaypointReach;
      while (distance <= waypointReach && waypointIndex < path.length - 1) {
        waypointIndex += 1;
        travel.pathIndex = waypointIndex;
        waypoint = path[waypointIndex] || travel.point;
        targetDx = getCommercialV2LoopDeltaX(currentPlayer.x, waypoint.x, stageSize.width);
        targetDy = waypoint.y - currentPlayer.y;
        distance = Math.hypot(targetDx, targetDy);
      }
      if (distance <= waypointReach) {
        autoTravelRef.current = null;
        setAutoTravelActive(false);
        setWorldPlayerBubble(travelPlayerId, travel.action);
        setNotice(`已到达 ${travel.label}，当前状态：${travel.action}。`);
        setPlayerById(travelPlayerId, (current) => ({
          ...current,
          x: wrapLoopCoordinate(waypoint.x, stageSize.width),
          y: waypoint.y,
          direction: travel.place?.facing || current.direction,
          moving: false,
          frame: 0,
          stepTime: 0
        }));
        return;
      }
      const normalizedX = targetDx / distance;
      const normalizedY = targetDy / distance;
      const direction = Math.abs(normalizedX) > Math.abs(normalizedY)
        ? (normalizedX > 0 ? 'right' : 'left')
        : (normalizedY > 0 ? 'front' : 'back');
      const travelSpeed = travel.behaviorRuntimeId ? commercialV2BehaviorPlayerSpeed : commercialV2PlayerSpeed;
      const frameRate = travel.behaviorRuntimeId ? 6 : 8;
      const stepDistance = Math.min(travelSpeed * delta, distance);
      const rawNextPoint = {
        x: wrapLoopCoordinate(currentPlayer.x + normalizedX * stepDistance, stageSize.width),
        y: currentPlayer.y + normalizedY * stepDistance
      };
      const groundedPoint = travel.semanticSlide
        ? rawNextPoint
        : resolvePlayerGroundMove(
          currentPlayer,
          rawNextPoint.x,
          rawNextPoint.y,
          { useAutoTravelBlocks: true }
        );
      const stepTime = currentPlayer.stepTime + delta;
      setPlayerById(travelPlayerId, {
        x: groundedPoint.x,
        y: groundedPoint.y,
        direction,
        moving: true,
        stepTime,
        frame: Math.floor(stepTime * frameRate) % commercialV2PlayerFrameOrder.length
      });
    };
    const tick = (time) => {
      const delta = Math.min(0.05, (time - previousTime) / 1000);
      previousTime = time;
      advanceBehaviorRuntimeRef.current();
      const keys = pressedKeysRef.current;
      let dx = 0;
      let dy = 0;
      if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
      if (keys.has('d') || keys.has('arrowright')) dx += 1;
      if (keys.has('w') || keys.has('arrowup')) dy -= 1;
      if (keys.has('s') || keys.has('arrowdown')) dy += 1;
      const moving = dx !== 0 || dy !== 0;
      if (moving) stepConcurrentAutoTravel(delta);
      if (!moving) {
        const travel = autoTravelRef.current;
        if (travel) {
          const travelPlayerId = travel.playerId || controlledPlayerIdRef.current;
          const travelCharacter = commercialV2PlayerCharacterById.get(travelPlayerId) || commercialV2PlayerCharacters[0];
          const currentPlayer = playersRef.current[travelPlayerId] || createCommercialV2PlayerState(travelCharacter);
          const path = travel.path?.length ? travel.path : [travel.point];
          let waypointIndex = Math.min(travel.pathIndex || 0, path.length - 1);
          let waypoint = path[waypointIndex] || travel.point;
          let targetDx = getCommercialV2LoopDeltaX(currentPlayer.x, waypoint.x, stageSize.width);
          let targetDy = waypoint.y - currentPlayer.y;
          let distance = Math.hypot(targetDx, targetDy);
          const waypointReach = travel.behaviorRuntimeId ? Math.max(5, commercialV2PathWaypointReach * 0.65) : commercialV2PathWaypointReach;
          while (distance <= waypointReach && waypointIndex < path.length - 1) {
            waypointIndex += 1;
            travel.pathIndex = waypointIndex;
            waypoint = path[waypointIndex] || travel.point;
            targetDx = getCommercialV2LoopDeltaX(currentPlayer.x, waypoint.x, stageSize.width);
            targetDy = waypoint.y - currentPlayer.y;
            distance = Math.hypot(targetDx, targetDy);
          }
          if (distance <= waypointReach) {
            if (travel.mode === 'streetCruise') {
              const arrivedPoint = {
                x: wrapLoopCoordinate(waypoint.x, stageSize.width),
                y: waypoint.y
              };
              const nextCruise = buildStreetCruiseSegment(arrivedPoint);
              if (nextCruise?.waypoints?.length) {
                autoTravelRef.current = {
                  ...travel,
                  point: nextCruise.destination,
                  anchorPoint: nextCruise.anchorPoint,
                  path: nextCruise.waypoints,
                  score: nextCruise.totalDistance,
                  pathIndex: 0,
                  stuckTime: 0,
                  replanCount: 0,
                  lastX: arrivedPoint.x,
                  lastY: arrivedPoint.y
                };
                setWorldPlayerBubble(travelPlayerId, `逛 ${travel.label}`);
                setPlayerById(travelPlayerId, (current) => ({
                  ...current,
                  ...arrivedPoint,
                  direction: 'right',
                  moving: true
                }));
                frameId = requestAnimationFrame(tick);
                return;
              }
              autoTravelRef.current = null;
              setAutoTravelActive(false);
              setWorldPlayerBubble(travelPlayerId, '');
              setNotice(`${travel.label} 前方没有可继续行走的路，已先停下。`);
              setPlayerById(travelPlayerId, (current) => ({
                ...current,
                ...arrivedPoint,
                direction: 'right',
                moving: false,
                frame: 0,
                stepTime: 0
              }));
              frameId = requestAnimationFrame(tick);
              return;
            }
            autoTravelRef.current = null;
            setAutoTravelActive(false);
            setWorldPlayerBubble(travelPlayerId, travel.action);
            setNotice(`已到达 ${travel.label}，当前状态：${travel.action}。`);
            setPlayerById(travelPlayerId, (current) => ({
              ...current,
              x: wrapLoopCoordinate(waypoint.x, stageSize.width),
              y: waypoint.y,
              direction: travel.place.facing || current.direction,
              moving: false,
              frame: 0,
              stepTime: 0
            }));
            frameId = requestAnimationFrame(tick);
            return;
          }
          const normalizedX = targetDx / distance;
          const normalizedY = targetDy / distance;
          const direction = Math.abs(normalizedX) > Math.abs(normalizedY)
            ? (normalizedX > 0 ? 'right' : 'left')
            : (normalizedY > 0 ? 'front' : 'back');
          const travelDelta = delta;
          const travelSpeed = travel.behaviorRuntimeId ? commercialV2BehaviorPlayerSpeed : commercialV2PlayerSpeed;
          const frameRate = travel.behaviorRuntimeId ? 6 : 8;
          const stepDistance = Math.min(travelSpeed * travelDelta, distance);
          const rawNextPoint = {
            x: wrapLoopCoordinate(currentPlayer.x + normalizedX * stepDistance, stageSize.width),
            y: currentPlayer.y + normalizedY * stepDistance
          };
          const groundedPoint = travel.semanticSlide
            ? rawNextPoint
            : resolvePlayerGroundMove(
              currentPlayer,
              rawNextPoint.x,
              rawNextPoint.y,
              { useAutoTravelBlocks: true }
            );
          const movedDistance = Math.hypot(
            getCommercialV2LoopDeltaX(currentPlayer.x, groundedPoint.x, stageSize.width),
            currentPlayer.y - groundedPoint.y
          );
          const nextDistance = Math.hypot(
            getCommercialV2LoopDeltaX(groundedPoint.x, waypoint.x, stageSize.width),
            waypoint.y - groundedPoint.y
          );
          travel.stuckTime = !travel.semanticSlide && movedDistance < 0.25 && nextDistance > 10
            ? (travel.stuckTime || 0) + delta
            : 0;
          if (!travel.semanticSlide && travel.stuckTime > 1.2) {
            const reroute = (travel.replanCount || 0) < 2
              ? (travel.mode === 'streetCruise'
                ? buildStreetCruiseSegment(groundedPoint)
                : buildAutoTravelPath(groundedPoint, travel.anchorPoint || travel.point))
              : null;
            if (reroute?.waypoints?.length) {
              travel.path = reroute.waypoints;
              travel.point = reroute.destination;
              if (reroute.anchorPoint) travel.anchorPoint = reroute.anchorPoint;
              travel.pathIndex = 0;
              travel.stuckTime = 0;
              travel.replanCount = (travel.replanCount || 0) + 1;
              setNotice(travel.mode === 'streetCruise'
                ? `${travel.label} 前方被挡住了，正在换一条路继续往前走。`
                : `去 ${travel.label} 的路被挡住了，正在重新绕路。`);
              frameId = requestAnimationFrame(tick);
              return;
            }
            autoTravelRef.current = null;
            setAutoTravelActive(false);
            setWorldPlayerBubble(travelPlayerId, '');
            setNotice(travel.mode === 'streetCruise'
              ? `${travel.label} 前方被碰撞挡住了，先停在附近。`
              : `去 ${travel.label} 的路被碰撞挡住了，先停在附近。`);
            setPlayerById(travelPlayerId, (current) => ({
              ...current,
              moving: false,
              frame: 0,
              stepTime: 0
            }));
            frameId = requestAnimationFrame(tick);
            return;
          }
          const stepTime = currentPlayer.stepTime + travelDelta;
          setPlayerById(travelPlayerId, {
            x: groundedPoint.x,
            y: groundedPoint.y,
            direction,
            moving: true,
            stepTime,
            frame: Math.floor(stepTime * frameRate) % commercialV2PlayerFrameOrder.length
          });
          frameId = requestAnimationFrame(tick);
          return;
        }
        if (playerRef.current.moving || playerRef.current.frame !== 0) {
          setPlayer((current) => ({ ...current, moving: false, frame: 0, stepTime: 0 }));
        }
        frameId = requestAnimationFrame(tick);
        return;
      }

      const length = Math.hypot(dx, dy) || 1;
      const normalizedX = dx / length;
      const normalizedY = dy / length;
      const direction = Math.abs(normalizedX) > Math.abs(normalizedY)
        ? (normalizedX > 0 ? 'right' : 'left')
        : (normalizedY > 0 ? 'front' : 'back');

      setPlayer((current) => {
        const stepTime = current.stepTime + delta;
        const groundedPoint = resolvePlayerGroundMove(
          current,
          current.x + normalizedX * commercialV2PlayerSpeed * delta,
          current.y + normalizedY * commercialV2PlayerSpeed * delta
        );
        return {
          x: groundedPoint.x,
          y: groundedPoint.y,
          direction,
          moving: true,
          stepTime,
          frame: Math.floor(stepTime * 8) % commercialV2PlayerFrameOrder.length
        };
      });
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [buildAutoTravelPath, buildStreetCruiseSegment, resolvePlayerGroundMove, setPlayer, setPlayerById, stageSize.width]);

  useEffect(() => {
    centerPlayerInView(!player.moving);
  }, [centerPlayerInView, player.moving]);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return undefined;
    const frameId = requestAnimationFrame(() => {
      const panelWidth = stageSize.width * zoom;
      if (!panelWidth) return;
      const requestedPosition = pendingLoopScrollRef.current;
      pendingLoopScrollRef.current = 'middle';
      if (requestedPosition === 'leftEdge') {
        wrap.scrollLeft = panelWidth;
        return;
      }
      if (requestedPosition === 'rightEdge') {
        wrap.scrollLeft = panelWidth + Math.max(0, panelWidth - wrap.clientWidth);
        return;
      }
      const localX = ((wrap.scrollLeft % panelWidth) + panelWidth) % panelWidth;
      wrap.scrollLeft = panelWidth + localX;
    });
    return () => cancelAnimationFrame(frameId);
  }, [stageSize.width, zoom]);

  function updateItem(id, patch, options = {}) {
    if (!canEditLayout) return;
    commitItems((prev) => prev.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      return options.wrapX ? wrapLoopBox(next, stageSize) : clampBox(next, stageSize);
    }));
  }

  function updateSelectedGroundLayer(enabled) {
    if (!selectedItem || !selectedAsset || selectedIsBuiltInGroundLayer) return;
    updateItem(selectedItem.id, { groundLayer: enabled ? true : undefined });
    setNotice(enabled
      ? `${selectedAsset.name} 已切到地面层：会恒在人物下方，碰撞箱不再阻挡人物。`
      : `${selectedAsset.name} 已切回普通素材：按图层和遮挡判断显示。`);
  }

  function addAsset(asset) {
    if (!canEditLayout) return;
    const count = items.filter((item) => item.assetId === asset.id).length + 1;
    const segmentIndex = (count - 1) % segmentCount;
    const localMaxX = Math.max(8, commercialV2SegmentSize.width - asset.box.w - 8);
    const localX = Math.max(8, Math.min((asset.box.x % commercialV2SegmentSize.width) + count * 12, localMaxX));
    const next = {
      assetId: asset.id,
      id: `${asset.id}-${Date.now().toString(36)}-${count}`,
      ...asset.box,
      x: segmentIndex * commercialV2SegmentSize.width + localX,
      y: Math.min(asset.box.y + count * 10, stageSize.height - asset.box.h),
      collision: getCommercialV2DefaultCollision(asset).enabled ? getCommercialV2DefaultCollision(asset) : undefined
    };
    commitItems((prev) => [...prev, clampBox(next, stageSize)]);
    setSelectedId(next.id);
  }

  function getLatestLayoutParts() {
    const latestItems = itemsRef.current;
    const latestSegmentCount = segmentCountRef.current;
    const latestStageSize = getCommercialV2StageSize(latestSegmentCount, latestItems);
    return {
      latestItems,
      latestSegmentCount,
      latestStageSize
    };
  }

  function saveLayout() {
    try {
      const { latestItems, latestSegmentCount, latestStageSize } = getLatestLayoutParts();
      const itemsToSave = latestItems
        .slice(0, commercialV2MaxSavedItems)
        .map((item) => serializeCommercialV2Item(item, assetById.get(item.assetId)));
      localStorage.setItem(commercialV2StorageKey, JSON.stringify(itemsToSave));
      localStorage.setItem(commercialV2CanvasStorageKey, JSON.stringify({
        segmentCount: latestSegmentCount,
        segment: { width: commercialV2SegmentSize.width, height: latestStageSize.height },
        backgroundColor: commercialV2BackgroundColor,
        loop: getCommercialV2Loop(latestStageSize)
      }));
      if (itemsToSave.length !== latestItems.length) {
        commitItems(itemsToSave);
        setNotice(`已保存前 ${itemsToSave.length} 个素材，超出部分已裁掉以避免页面卡死。`);
      } else {
        setNotice(`已保存 ${latestSegmentCount} 段纯色横向画布、${latestItems.length} 个素材和碰撞体积。`);
      }
    } catch (error) {
      console.error('[PixelWorld] Failed to save layout:', error);
      setNotice('保存失败：浏览器本地存储不可用或空间不足。');
    }
  }

  function writeResetBackup() {
    try {
      const { latestItems, latestSegmentCount } = getLatestLayoutParts();
      const backupItems = latestItems
        .slice(0, commercialV2MaxSavedItems)
        .map((item) => serializeCommercialV2Item(item, assetById.get(item.assetId)));
      const backup = {
        segmentCount: latestSegmentCount,
        selectedId,
        savedAt: Date.now(),
        items: backupItems
      };
      localStorage.setItem(commercialV2ResetBackupStorageKey, JSON.stringify(backup));
      setResetBackup(backup);
      return backup;
    } catch (error) {
      console.error('[PixelWorld] Failed to write reset backup:', error);
      return null;
    }
  }

  function buildLayoutSnapshot() {
    const { latestItems, latestSegmentCount } = getLatestLayoutParts();
    return {
      segmentCount: latestSegmentCount,
      selectedId,
      savedAt: Date.now(),
      items: latestItems
        .slice(0, commercialV2MaxSavedItems)
        .map((item) => serializeCommercialV2Item(item, assetById.get(item.assetId)))
    };
  }

  function saveCurrentAsDefaultScene() {
    try {
      const snapshot = buildLayoutSnapshot();
      localStorage.setItem(commercialV2DefaultSnapshotStorageKey, JSON.stringify(snapshot));
      localStorage.setItem(commercialV2StorageKey, JSON.stringify(snapshot.items));
      localStorage.setItem(commercialV2CanvasStorageKey, JSON.stringify({
        segmentCount,
        segment: { width: commercialV2SegmentSize.width, height: stageSize.height },
        backgroundColor: commercialV2BackgroundColor,
        loop: getCommercialV2Loop(stageSize)
      }));
      setNotice(`已把当前 ${snapshot.items.length} 个素材保存为默认场景；以后“恢复默认”和重新进入都会使用这个快照。`);
    } catch (error) {
      console.error('[PixelWorld] Failed to save default scene snapshot:', error);
      setNotice('保存默认场景失败：浏览器本地存储不可用或空间不足。');
    }
  }

  function applyLayoutSnapshot(snapshot, message = '已恢复上次布局。') {
    if (!snapshot?.items?.length) {
      setNotice('没有找到可恢复的布局备份。');
      return;
    }
    const normalized = normalizeCommercialV2LayoutState(snapshot.items, snapshot.segmentCount);
    if (!normalized?.items?.length) {
      setNotice('找到备份了，但里面没有可用素材。');
      return;
    }
    const nextStageSize = getCommercialV2StageSize(normalized.segmentCount, normalized.items);
    const itemsToSave = normalized.items
      .slice(0, commercialV2MaxSavedItems)
      .map((item) => serializeCommercialV2Item(item, assetById.get(item.assetId)));
    try {
      localStorage.setItem(commercialV2StorageKey, JSON.stringify(itemsToSave));
      localStorage.setItem(commercialV2CanvasStorageKey, JSON.stringify({
        segmentCount: normalized.segmentCount,
        segment: { width: commercialV2SegmentSize.width, height: nextStageSize.height },
        backgroundColor: commercialV2BackgroundColor,
        loop: getCommercialV2Loop(nextStageSize)
      }));
    } catch (error) {
      console.error('[PixelWorld] Failed to persist restored layout:', error);
    }
    commitItems(normalized.items);
    commitSegmentCount(normalized.segmentCount);
    setSelectedId(snapshot.selectedId || normalized.items[0]?.id || '');
    cancelAutoTravel();
    spawnPlayersOnStage(createCommercialV2PlayerStates());
    setNotice(message);
  }

  async function restoreResetBackup() {
    if (!canEditLayout) return;
    if (resetBackup?.items?.length) {
      applyLayoutSnapshot(resetBackup, `已恢复误点前的 ${resetBackup.items.length} 个素材。`);
      return;
    }
    try {
      const layoutResponse = await fetch(commercialV2RecoveredLayoutUrl);
      if (!layoutResponse.ok) {
        setNotice('没有找到可恢复的布局备份。');
        return;
      }
      const recoveredItems = await layoutResponse.json();
      let recoveredCanvas = null;
      try {
        const canvasResponse = await fetch(commercialV2RecoveredCanvasUrl);
        if (canvasResponse.ok) recoveredCanvas = await canvasResponse.json();
      } catch {
        recoveredCanvas = null;
      }
      applyLayoutSnapshot({
        items: recoveredItems,
        segmentCount: recoveredCanvas?.segmentCount || getRequiredSegmentCount(recoveredItems),
        selectedId: recoveredItems[0]?.id || ''
      }, `已从恢复文件找回 ${recoveredItems.length} 个素材。`);
    } catch (error) {
      console.error('[PixelWorld] Failed to restore recovered layout:', error);
      setNotice('恢复失败：没读到可用的备份文件。');
    }
  }

  function resetLayout() {
    if (!canEditLayout) return;
    writeResetBackup();
    const defaultLayout = getDefaultCommercialLayoutState();
    const defaultItems = defaultLayout.items;
    const defaultSegmentCount = defaultLayout.segmentCount || getRequiredSegmentCount(defaultItems);
    commitItems(defaultItems);
    commitSegmentCount(defaultSegmentCount);
    setSelectedId(defaultLayout.selectedId || defaultItems[0]?.id || '');
    cancelAutoTravel();
    spawnPlayersOnStage(createCommercialV2PlayerStates());
    localStorage.removeItem(commercialV2StorageKey);
    localStorage.removeItem(commercialV2CanvasStorageKey);
    setNotice(defaultLayout.savedAt
      ? '已恢复为你保存的默认场景；误点的话可以点“恢复上次布局”。'
      : '已恢复为内置默认素材摆放；误点的话可以点“恢复上次布局”。');
  }

  async function copyLayout() {
    try {
      await navigator.clipboard.writeText(layoutJson);
      setNotice('布局 JSON 已复制，可以直接发给我。');
    } catch {
      setNotice('复制失败，但下方 JSON 可以手动选中。');
    }
  }

  function deleteSelected() {
    if (!canEditLayout || !selectedId) return;
    commitItems((prev) => prev.filter((item) => item.id !== selectedId));
    setSelectedId('');
  }

  function moveGroup(dx, dy) {
    if (!canEditLayout) return;
    commitItems((prev) => prev.map((item) => clampBox({
      ...item,
      x: item.x + dx,
      y: item.y + dy
    }, stageSize)));
  }

  function bringSelectedToFront() {
    if (!canEditLayout || !selectedId) return;
    commitItems((prev) => {
      const selected = prev.find((item) => item.id === selectedId);
      if (!selected) return prev;
      return [...prev.filter((item) => item.id !== selectedId), selected];
    });
  }

  function sendSelectedToBack() {
    if (!canEditLayout || !selectedId) return;
    commitItems((prev) => {
      const index = prev.findIndex((item) => item.id === selectedId);
      if (index <= 0) return prev;
      const next = prev.slice();
      const [selected] = next.splice(index, 1);
      next.unshift(selected);
      return next;
    });
  }

  function moveSelectedLayer(direction) {
    if (!canEditLayout || !selectedId) return;
    commitItems((prev) => {
      const index = prev.findIndex((item) => item.id === selectedId);
      if (index < 0) return prev;
      const nextIndex = direction === 'up'
        ? Math.min(prev.length - 1, index + 1)
        : Math.max(0, index - 1);
      if (nextIndex === index) return prev;
      const next = prev.slice();
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  }

  function scaleSelected(multiplier) {
    if (!canEditLayout) return;
    if (groupEditMode) {
      scaleGroup(multiplier);
      return;
    }
    if (!selectedItem) return;
    const nextW = selectedItem.w * multiplier;
    const nextH = selectedItem.h * multiplier;
    updateItem(selectedItem.id, {
      x: selectedItem.x - (nextW - selectedItem.w) / 2,
      y: selectedItem.y - (nextH - selectedItem.h),
      w: nextW,
      h: nextH
    });
  }

  function scaleGroup(multiplier) {
    if (!canEditLayout) return;
    if (!layoutBounds) return;
    const originX = (layoutBounds.minX + layoutBounds.maxX) / 2;
    const originY = layoutBounds.maxY;
    commitItems((prev) => prev.map((item) => clampBox({
      ...item,
      x: originX + (item.x - originX) * multiplier,
      y: originY + (item.y - originY) * multiplier,
      w: item.w * multiplier,
      h: item.h * multiplier
    }, stageSize)));
  }

  function nudgeSelected(dx, dy) {
    if (!canEditLayout) return;
    if (groupEditMode) {
      moveGroup(dx, dy);
      return;
    }
    if (!selectedItem) return;
    updateItem(selectedItem.id, { x: selectedItem.x + dx, y: selectedItem.y + dy }, { wrapX: true });
  }

  function updateSelectedCollisionEnabled(enabled) {
    if (!canEditLayout) return;
    if (!selectedItem || !selectedAsset) return;
    if (!canCommercialV2ItemCollisionTakeEffect(selectedItem, selectedAsset)) {
      setShowCollisionLines(true);
      setNotice('地面层规则已生效：这个实例的碰撞箱不会阻挡人物。');
      return;
    }
    setShowCollisionLines(true);
    updateItem(selectedItem.id, {
      collision: {
        ...normalizeCommercialV2Collision(selectedItem.collision, selectedAsset),
        enabled
      }
    });
  }

  function updateSelectedCollisionLocalBox(key, value) {
    if (!canEditLayout) return;
    if (!selectedItem || !selectedAsset || !selectedCollisionLocalBox) return;
    if (!canCommercialV2ItemCollisionTakeEffect(selectedItem, selectedAsset)) {
      setShowCollisionLines(true);
      setNotice('地面层规则已生效：这个实例的碰撞箱不会阻挡人物。');
      return;
    }
    setShowCollisionLines(true);
    const pixelValue = Math.round(Number(value) || 0);
    const nextLocalBox = {
      ...selectedCollisionLocalBox,
      [key]: pixelValue
    };
    updateItem(selectedItem.id, {
      collision: normalizeCommercialV2Collision({
        enabled: selectedCollision?.enabled ?? true,
        x: nextLocalBox.x / selectedItem.w,
        y: nextLocalBox.y / selectedItem.h,
        w: nextLocalBox.w / selectedItem.w,
        h: nextLocalBox.h / selectedItem.h
      }, selectedAsset)
    });
  }

  function updateCollisionFromLocalBox(item, asset, localBox) {
    if (!canCommercialV2ItemCollisionTakeEffect(item, asset)) {
      setNotice('地面层规则已生效：这个实例的碰撞箱不会阻挡人物。');
      return;
    }
    const safeLocalBox = {
      x: Number.isFinite(localBox.x) ? localBox.x : 0,
      y: Number.isFinite(localBox.y) ? localBox.y : 0,
      w: Math.max(2, Number.isFinite(localBox.w) ? localBox.w : 2),
      h: Math.max(2, Number.isFinite(localBox.h) ? localBox.h : 2)
    };
    updateItem(item.id, {
      collision: normalizeCommercialV2Collision({
        enabled: true,
        x: safeLocalBox.x / item.w,
        y: safeLocalBox.y / item.h,
        w: safeLocalBox.w / item.w,
        h: safeLocalBox.h / item.h
      }, asset)
    });
  }

  function resetSelectedCollision() {
    if (!canEditLayout) return;
    if (!selectedItem || !selectedAsset) return;
    if (!canCommercialV2ItemCollisionTakeEffect(selectedItem, selectedAsset)) {
      setShowCollisionLines(true);
      setNotice('地面层规则已生效：这个实例的碰撞箱不会阻挡人物。');
      return;
    }
    setShowCollisionLines(true);
    updateItem(selectedItem.id, {
      collision: getCommercialV2DefaultCollision(selectedAsset)
    });
  }

  function fitSelectedCollisionToSprite() {
    if (!canEditLayout) return;
    if (!selectedItem || !selectedAsset) return;
    if (!canCommercialV2ItemCollisionTakeEffect(selectedItem, selectedAsset)) {
      setShowCollisionLines(true);
      setNotice('地面层规则已生效：这个实例的碰撞箱不会阻挡人物。');
      return;
    }
    setShowCollisionLines(true);
    updateItem(selectedItem.id, {
      collision: normalizeCommercialV2Collision({ enabled: true, x: 0, y: 0, w: 1, h: 1 }, selectedAsset)
    });
  }

  function updatePlaceAnchorFromLocalPoint(item, localPoint) {
    if (!item?.w || !item?.h) return;
    const safeLocalPoint = {
      x: Number.isFinite(localPoint.x) ? localPoint.x : 0,
      y: Number.isFinite(localPoint.y) ? localPoint.y : 0
    };
    updateItem(item.id, {
      placeAnchor: normalizeCommercialV2PlaceAnchor({
        x: safeLocalPoint.x / item.w,
        y: safeLocalPoint.y / item.h
      })
    });
  }

  function updateSelectedPlaceAnchorLocalPoint(key, value) {
    if (!canEditLayout) return;
    if (!selectedItem || !selectedPlaceAnchorLocalPoint) return;
    setShowPlaceAnchors(true);
    const pixelValue = Math.round(Number(value) || 0);
    updatePlaceAnchorFromLocalPoint(selectedItem, {
      ...selectedPlaceAnchorLocalPoint,
      [key]: pixelValue
    });
  }

  function resetSelectedPlaceAnchor() {
    if (!canEditLayout) return;
    if (!selectedItem || !selectedPlace) return;
    setShowPlaceAnchors(true);
    updateItem(selectedItem.id, { placeAnchor: undefined });
  }

  function onCollisionPointerDown(event, item, asset, visualOffset, handle = 'move') {
    if (!canEditLayout || groupEditMode) return;
    if (!canCommercialV2ItemCollisionTakeEffect(item, asset)) return;
    event.preventDefault();
    event.stopPropagation();
    const stage = event.currentTarget.closest('.pixel-world-editor-stage') || stageRef.current;
    if (!stage) return;
    const collision = normalizeCommercialV2Collision(item.collision, asset);
    if (!collision.enabled) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startPoint = getPointerStagePoint(event, stage, stageSize);
    const startLocalBox = {
      x: collision.x * item.w,
      y: collision.y * item.h,
      w: collision.w * item.w,
      h: collision.h * item.h
    };
    dragRef.current = {
      id: item.id,
      mode: 'collision',
      stage,
      visualOffset,
      handle,
      startPoint,
      startItem: item,
      startAsset: asset,
      startLocalBox
    };
    setSelectedId(item.id);
    setShowCollisionLines(true);
  }

  function onPlaceAnchorPointerDown(event, item, asset, visualOffset = 0) {
    if (!canEditLayout || groupEditMode) return;
    event.preventDefault();
    event.stopPropagation();
    const stage = event.currentTarget.closest('.pixel-world-editor-stage') || stageRef.current;
    if (!stage) return;
    const place = buildCommercialV2ItemPlace(item, asset);
    if (!place) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startPoint = getPointerStagePoint(event, stage, stageSize);
    dragRef.current = {
      id: item.id,
      mode: 'place-anchor',
      stage,
      visualOffset,
      startPoint,
      startItem: item,
      startLocalPoint: {
        x: place.anchor.x - item.x,
        y: place.anchor.y - item.y
      }
    };
    setSelectedId(item.id);
    setShowPlaceAnchors(true);
  }

  function onPointerDown(event, item, visualOffset = 0) {
    if (!canEditLayout) {
      event.preventDefault();
      return;
    }
    const stage = event.currentTarget.closest('.pixel-world-editor-stage') || stageRef.current;
    if (!stage) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = getPointerStagePoint(event, stage, stageSize);
    dragRef.current = {
      id: item.id,
      mode: groupEditMode ? 'group' : 'single',
      stage,
      visualOffset,
      dx: point.x - (item.x + visualOffset),
      dy: point.y - item.y,
      startPoint: point,
      startItems: items
    };
    setSelectedId(item.id);
  }

  function applyDragPoint(point) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === 'collision') {
      const deltaX = point.x - drag.startPoint.x;
      const deltaY = point.y - drag.startPoint.y;
      const start = drag.startLocalBox;
      const minSize = Math.max(4, Math.min(drag.startItem.w, drag.startItem.h) * 0.03);
      let nextX = start.x;
      let nextY = start.y;
      let nextW = start.w;
      let nextH = start.h;
      if (drag.handle === 'move') {
        nextX = start.x + deltaX;
        nextY = start.y + deltaY;
      } else {
        if (drag.handle.includes('w')) {
          nextX = start.x + deltaX;
          nextW = start.w - deltaX;
        }
        if (drag.handle.includes('e')) {
          nextW = start.w + deltaX;
        }
        if (drag.handle.includes('n')) {
          nextY = start.y + deltaY;
          nextH = start.h - deltaY;
        }
        if (drag.handle.includes('s')) {
          nextH = start.h + deltaY;
        }
      }
      if (nextW < minSize) {
        if (drag.handle.includes('w')) nextX -= minSize - nextW;
        nextW = minSize;
      }
      if (nextH < minSize) {
        if (drag.handle.includes('n')) nextY -= minSize - nextH;
        nextH = minSize;
      }
      updateCollisionFromLocalBox(drag.startItem, drag.startAsset, {
        x: nextX,
        y: nextY,
        w: nextW,
        h: nextH
      });
      return;
    }
    if (drag.mode === 'place-anchor') {
      const deltaX = point.x - drag.startPoint.x;
      const deltaY = point.y - drag.startPoint.y;
      updatePlaceAnchorFromLocalPoint(drag.startItem, {
        x: drag.startLocalPoint.x + deltaX,
        y: drag.startLocalPoint.y + deltaY
      });
      return;
    }
    if (drag.mode === 'group') {
      const deltaX = point.x - drag.startPoint.x;
      const deltaY = point.y - drag.startPoint.y;
      commitItems(drag.startItems.map((item) => clampBox({
        ...item,
        x: item.x + deltaX,
        y: item.y + deltaY
      }, stageSize)));
      return;
    }
    updateItem(drag.id, { x: point.x - drag.dx - (drag.visualOffset || 0), y: point.y - drag.dy }, { wrapX: true });
  }

  function onPointerMove(event) {
    const drag = dragRef.current;
    const stage = drag?.stage || stageRef.current;
    if (!drag || !stage) return;
    pendingDragPointRef.current = getPointerStagePoint(event, stage, stageSize);
    if (dragFrameRef.current) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      if (!pendingDragPointRef.current) return;
      applyDragPoint(pendingDragPointRef.current);
    });
  }

  function onPointerUp(event) {
    const stage = dragRef.current?.stage || stageRef.current;
    if (dragRef.current && stage && event?.clientX !== undefined) {
      pendingDragPointRef.current = getPointerStagePoint(event, stage, stageSize);
      applyDragPoint(pendingDragPointRef.current);
    }
    if (dragFrameRef.current) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    pendingDragPointRef.current = null;
    dragRef.current = null;
  }

  function appendCanvasSegment() {
    if (!canEditLayout) return;
    const nextSegmentCount = normalizeSegmentCount(segmentCount + 1);
    if (nextSegmentCount === segmentCount) {
      setNotice(`已经到 ${commercialV2MaxSegmentCount} 段，先别把页面撑成宇宙。`);
      return;
    }
    commitSegmentCount(nextSegmentCount);
    setNotice(`已在尾部追加 ${commercialV2SegmentSize.width}px 纯色背景，当前 ${nextSegmentCount} 段。`);
    pendingLoopScrollRef.current = 'rightEdge';
  }

  function prependCanvasSegment() {
    if (!canEditLayout) return;
    const nextSegmentCount = normalizeSegmentCount(segmentCount + 1);
    if (nextSegmentCount === segmentCount) {
      setNotice(`已经到 ${commercialV2MaxSegmentCount} 段，先别把页面撑成宇宙。`);
      return;
    }
    const shiftedItems = items.map((item) => ({
      ...item,
      x: item.x + commercialV2SegmentSize.width
    }));
    const nextStageSize = getCommercialV2StageSize(nextSegmentCount, shiftedItems);
    commitSegmentCount(nextSegmentCount);
    commitItems(shiftedItems.map((item) => clampBox(item, nextStageSize)));
    setNotice(`已在左边追加 ${commercialV2SegmentSize.width}px 纯色背景，当前 ${nextSegmentCount} 段。`);
    pendingLoopScrollRef.current = 'leftEdge';
  }

  function onLoopScroll(event) {
    if (loopScrollGuardRef.current) return;
    const wrap = event.currentTarget;
    const panelWidth = stageSize.width * zoom;
    if (!panelWidth) return;
    const leftWrapPoint = Math.max(0, panelWidth - wrap.clientWidth);
    const rightWrapPoint = panelWidth * 2;
    if (wrap.scrollLeft <= leftWrapPoint) {
      loopScrollGuardRef.current = true;
      wrap.scrollLeft += panelWidth;
      requestAnimationFrame(() => {
        loopScrollGuardRef.current = false;
      });
      return;
    }
    if (wrap.scrollLeft >= rightWrapPoint) {
      loopScrollGuardRef.current = true;
      wrap.scrollLeft -= panelWidth;
      requestAnimationFrame(() => {
        loopScrollGuardRef.current = false;
      });
    }
  }

  function removeCanvasSegment() {
    if (!canEditLayout) return;
    const requiredSegmentCount = getRequiredSegmentCount(items);
    if (segmentCount <= requiredSegmentCount) {
      setNotice('尾部这一段已经被素材占用，先把尾部素材移回来再收回。');
      return;
    }
    const nextSegmentCount = normalizeSegmentCount(segmentCount - 1);
    if (nextSegmentCount === segmentCount) return;
    const nextStageSize = getCommercialV2StageSize(nextSegmentCount, items);
    commitSegmentCount(nextSegmentCount);
    commitItems((prev) => prev.map((item) => clampBox(item, nextStageSize)));
    setNotice(`已收回 1 段，当前 ${nextSegmentCount} 段。`);
  }

  function renderEditorPanel(panelKey, interactive = false) {
    function getLoopOffsets(item, asset) {
      const offsets = [0];
      if (isCommercialV2SkyStripAsset(asset) && item.w > 0) {
        const minCopy = Math.floor((-item.x - item.w) / item.w);
        const maxCopy = Math.ceil((stageSize.width - item.x) / item.w);
        for (let copy = minCopy; copy <= maxCopy; copy += 1) {
          const offset = copy * item.w;
          const left = item.x + offset;
          const right = left + item.w;
          if (right > 0 && left < stageSize.width) offsets.push(offset);
        }
        return [...new Set(offsets)];
      }
      if (item.x <= commercialV2LoopSeamMargin) offsets.push(stageSize.width);
      if (item.x + item.w >= stageSize.width - commercialV2LoopSeamMargin) offsets.push(-stageSize.width);
      return offsets;
    }

    function getItemStyle(item, offset = 0, zIndex = 1) {
      const style = {
        left: `${((item.x + offset) / stageSize.width) * 100}%`,
        top: `${(item.y / stageSize.height) * 100}%`,
        width: `${(item.w / stageSize.width) * 100}%`,
        height: `${(item.h / stageSize.height) * 100}%`,
        zIndex
      };
      return style;
    }

    function getItemZIndex(layerIndex, item, asset, playerZIndex = null) {
      const zIndex = getCommercialV2ItemRenderZIndex(layerIndex, item, asset);
      if (asset && isCommercialV2GroundLayerItem(item, asset) && Number.isFinite(playerZIndex)) {
        return Math.min(zIndex, playerZIndex - 1);
      }
      return zIndex;
    }

    function getPlayerOcclusionProbeForOffset(targetPlayer, offset = 0) {
      const visualX = targetPlayer.x + offset;
      const probeWidth = Math.max(28, playerDimensions.width * 0.44);
      const probeHeight = Math.max(34, playerDimensions.height * 0.36);
      return {
        x: visualX - probeWidth / 2,
        y: targetPlayer.y - probeHeight,
        w: probeWidth,
        h: probeHeight + playerDimensions.footOffset
      };
    }

    function getPlayerOccludingLayerIndex(targetPlayer) {
      let occludingLayerIndex = null;
      const playerBoxes = getPlayerLoopOffsets(targetPlayer).map((offset) => ({
        probe: getPlayerOcclusionProbeForOffset(targetPlayer, offset)
      }));
      items.forEach((item, layerIndex) => {
        const asset = assetById.get(item.assetId);
        if (!isCommercialV2DynamicOcclusionItem(item, asset)) return;
        const silhouette = assetSilhouettes[item.assetId];
        getLoopOffsets(item, asset).forEach((itemOffset) => {
          playerBoxes.forEach(({ probe }) => {
            const shouldOcclude = getCommercialV2OcclusionDecision(
              item,
              asset,
              silhouette,
              probe,
              targetPlayer.y,
              itemOffset
            ) === 'front';
            if (!shouldOcclude) return;
            occludingLayerIndex = occludingLayerIndex === null
              ? layerIndex
              : Math.min(occludingLayerIndex, layerIndex);
          });
        });
      });
      return occludingLayerIndex;
    }

    function getPlayerZIndex(targetPlayer) {
      const characterIndex = Math.max(0, commercialV2PlayerCharacters.findIndex((character) => character.id === targetPlayer.id));
      const occludingLayerIndex = getPlayerOccludingLayerIndex(targetPlayer);
      if (occludingLayerIndex !== null) {
        const occludingItem = items[occludingLayerIndex];
        const occludingAsset = occludingItem ? assetById.get(occludingItem.assetId) : null;
        return getCommercialV2ItemRenderZIndex(occludingLayerIndex, occludingItem, occludingAsset) - 5;
      }
      return getCommercialV2PlayerRenderZIndex(targetPlayer, characterIndex * commercialV2PlayerLayerGap);
    }

    function renderEditorItem(panelItem, asset, offset, isGhost, layerIndex, playerZIndex) {
      const collision = getCommercialV2EffectiveCollision(panelItem, asset);
      const isSelected = canEditLayout && selectedId === panelItem.id;
      const canEditCollisionBox = showCollisionLines && isSelected && !isGhost && !groupEditMode;
      const collisionHandles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      return (
        <button
          key={`${panelKey}-${panelItem.id}-${isGhost ? 'ghost' : 'active'}-${offset}`}
          type="button"
          className={`pixel-world-editor-item ${isGhost ? 'loop-ghost' : ''} ${isSelected ? 'selected' : ''} ${canEditLayout && groupEditMode ? 'group-bound' : ''}`}
          style={getItemStyle(panelItem, offset, getItemZIndex(layerIndex, panelItem, asset, playerZIndex))}
          onPointerDown={(event) => onPointerDown(event, panelItem, offset)}
          onClick={() => {
            if (canEditLayout) setSelectedId(panelItem.id);
          }}
          title={asset.name}
        >
          <img src={commercialV2Asset(asset.path)} alt="" draggable={false} />
          {showLayerPanel && (
            <span className={`pixel-world-layer-badge ${isCommercialV2GroundLayerItem(panelItem, asset) ? 'ground' : 'asset'}`}>
              {layerIndex + 1}
            </span>
          )}
          {showCollisionLines && collision.enabled && (
            <span
              className={`pixel-world-collision-box ${isSelected ? 'selected' : ''} ${canEditCollisionBox ? 'editable' : ''}`}
              onPointerDown={canEditCollisionBox
                ? (event) => onCollisionPointerDown(event, panelItem, asset, offset, 'move')
                : undefined}
              style={{
                left: `${collision.x * 100}%`,
                top: `${collision.y * 100}%`,
                width: `${collision.w * 100}%`,
                height: `${collision.h * 100}%`
              }}
            >
              {canEditCollisionBox && collisionHandles.map((handle) => (
                <span
                  key={handle}
                  className={`pixel-world-collision-handle handle-${handle}`}
                  onPointerDown={(event) => onCollisionPointerDown(event, panelItem, asset, offset, handle)}
                />
              ))}
            </span>
          )}
        </button>
      );
    }

    function renderPlaceAnchor(panelItem, asset, offset, layerIndex, playerZIndex) {
      const place = buildCommercialV2ItemPlace(panelItem, asset);
      if (!place) return null;
      const isSelected = canEditLayout && selectedId === panelItem.id;
      const canEditPlaceAnchor = isSelected && !groupEditMode && offset === 0;
      const locationText = place.locationIds.join(' / ');
      return (
        <span
          key={`${panelKey}-${panelItem.id}-place-anchor-${offset}`}
          className={`pixel-world-place-anchor ${isSelected ? 'selected' : ''} ${canEditPlaceAnchor ? 'editable' : ''} ${place.manualAnchor ? 'manual' : ''}`}
          onPointerDown={canEditPlaceAnchor
            ? (event) => onPlaceAnchorPointerDown(event, panelItem, asset, offset)
            : undefined}
          style={{
            left: `${((place.anchor.x + offset) / stageSize.width) * 100}%`,
            top: `${(place.anchor.y / stageSize.height) * 100}%`,
            zIndex: playerZIndex + 80 + layerIndex
          }}
          title={`${place.name} -> ${locationText}`}
        >
          <span>{place.name}</span>
        </span>
      );
    }

    function getPlayerLoopOffsets(targetPlayer) {
      const offsets = [0];
      const halfWidth = playerDimensions.width / 2;
      if (targetPlayer.x - halfWidth < 0) offsets.push(stageSize.width);
      if (targetPlayer.x + halfWidth > stageSize.width) offsets.push(-stageSize.width);
      return offsets;
    }

    function renderPlayer(targetPlayer, offset = 0, zIndex = getPlayerZIndex(targetPlayer)) {
      const isControlled = targetPlayer.id === controlledPlayerId;
      const actorKind = targetPlayer.id === commercialV2RoleActorId
        ? 'role-actor'
        : targetPlayer.id === commercialV2UserActorId
          ? 'user-actor'
          : '';
      const actorLabel = actorKind === 'role-actor' ? '角色' : actorKind === 'user-actor' ? '玩家' : '';
      const frameName = targetPlayer.moving ? commercialV2PlayerFrameOrder[targetPlayer.frame] : 'idle';
      const src = commercialV2PlayerFrame(targetPlayer, `${targetPlayer.direction}_walk_${frameName}.png`);
      const visualX = targetPlayer.x + offset;
      const behaviorDialog = targetPlayer.id === commercialV2RoleActorId ? activeBehaviorDialog : null;
      const actionBubble = behaviorDialog ? '' : (playerActionBubbles[targetPlayer.id] || (isControlled ? playerActionBubble : ''));
      const playerLeftPx = (visualX - playerDimensions.width / 2) * zoom;
      const playerTopPx = (targetPlayer.y - playerDimensions.height + playerDimensions.footOffset) * zoom;
      const bubbleTop = ((targetPlayer.y - playerDimensions.height + playerDimensions.footOffset - 8) / stageSize.height) * 100;
      const dialogTop = (Math.max(20, targetPlayer.y - playerDimensions.height + playerDimensions.footOffset - 34) / stageSize.height) * 100;
      const nameplateTop = ((targetPlayer.y - playerDimensions.height + playerDimensions.footOffset - 22) / stageSize.height) * 100;
      const peerCollisionWidth = Math.max(
        commercialV2PlayerPeerCollision.minWidth,
        playerDimensions.width * commercialV2PlayerPeerCollision.widthRatio
      );
      const peerCollisionHeight = Math.max(
        commercialV2PlayerPeerCollision.minHeight,
        playerDimensions.footOffset * commercialV2PlayerPeerCollision.heightRatio
      );
      const peerCollisionBox = {
        x: visualX - peerCollisionWidth / 2,
        y: targetPlayer.y - peerCollisionHeight / 2,
        w: peerCollisionWidth,
        h: peerCollisionHeight
      };
      return (
        <React.Fragment key={`player-${targetPlayer.id}-${offset}`}>
          <img
            className={`pixel-world-player ${isControlled ? 'controlled' : ''} ${actorKind}`}
            src={src}
            alt=""
            draggable={false}
            style={{
              left: 0,
              top: 0,
              width: `${playerDimensions.width * zoom}px`,
              height: `${playerDimensions.height * zoom}px`,
              transform: `translate3d(${playerLeftPx}px, ${playerTopPx}px, 0)`,
              zIndex
            }}
          />
          {actorLabel && (
            <span
              className={`pixel-world-player-nameplate ${actorKind}`}
              style={{
                left: `${(visualX / stageSize.width) * 100}%`,
                top: `${nameplateTop}%`,
                zIndex: zIndex + 900
              }}
            >
              {actorLabel}
            </span>
          )}
          {actionBubble && (
            <span
              className="pixel-world-player-action-bubble"
              style={{
                left: `${(visualX / stageSize.width) * 100}%`,
                top: `${bubbleTop}%`,
                zIndex: zIndex + 1000
              }}
            >
              {actionBubble}
            </span>
          )}
          {behaviorDialog && (
            <div
              className={`pixel-world-behavior-dialog ${behaviorDialog.type || ''}`}
              style={{
                left: `${(visualX / stageSize.width) * 100}%`,
                top: `${dialogTop}%`,
                zIndex: zIndex + 1300
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="pixel-world-behavior-dialog-head">
                <strong>{behaviorDialog.title || '角色'}</strong>
                <span>{Math.min((behaviorDialog.stepIndex || 0) + 1, behaviorDialog.totalSteps || 1)}/{behaviorDialog.totalSteps || 1}</span>
              </div>
              <p>{behaviorDialog.text}</p>
              {behaviorDialog.type === 'pending' ? (
                <button type="button" disabled>生成中...</button>
              ) : behaviorDialog.type === 'choice' && behaviorDialog.choices?.length ? (
                <div className="pixel-world-behavior-dialog-choices">
                  {behaviorDialog.choices.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      onClick={() => chooseBehaviorDialogChoice(choice)}
                      disabled={behaviorLoading}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              ) : (
                <button type="button" onClick={continueBehaviorDialog}>
                  下一句
                </button>
              )}
            </div>
          )}
          {showCollisionLines && (
            <span
              className={`pixel-world-player-footprint ${isControlled ? 'controlled' : ''}`}
              style={{
                left: `${(peerCollisionBox.x / stageSize.width) * 100}%`,
                top: `${(peerCollisionBox.y / stageSize.height) * 100}%`,
                width: `${(peerCollisionBox.w / stageSize.width) * 100}%`,
                height: `${(peerCollisionBox.h / stageSize.height) * 100}%`,
                zIndex: zIndex + 1
              }}
            />
          )}
        </React.Fragment>
      );
    }

    function renderItemCopies(item, asset, interactivePanel, layerIndex, playerZIndex) {
      if (!interactivePanel) {
        return getLoopOffsets(item, asset).map((offset) => renderEditorItem(item, asset, offset, true, layerIndex, playerZIndex));
      }
      return [
        ...getLoopOffsets(item, asset).filter((offset) => offset !== 0).map((offset) => renderEditorItem(item, asset, offset, true, layerIndex, playerZIndex)),
        renderEditorItem(item, asset, 0, false, layerIndex, playerZIndex)
      ];
    }

    const controlledPlayerZIndex = getPlayerZIndex(player);
    const playerNodes = commercialV2PlayerCharacters.flatMap((character) => {
      const targetPlayer = players[character.id] || createCommercialV2PlayerState(character);
      const targetPlayerZIndex = getPlayerZIndex(targetPlayer);
      return getPlayerLoopOffsets(targetPlayer).map((offset) => renderPlayer(targetPlayer, offset, targetPlayerZIndex));
    });
    const placeAnchorNodes = [];
    const orderedNodes = [];
    items.forEach((item, layerIndex) => {
      const asset = assetById.get(item.assetId);
      if (!asset) return;
      orderedNodes.push(...renderItemCopies(item, asset, interactive, layerIndex, controlledPlayerZIndex));
      if (showPlaceAnchors) {
        getLoopOffsets(item, asset).forEach((offset) => {
          const anchorNode = renderPlaceAnchor(item, asset, offset, layerIndex, controlledPlayerZIndex);
          if (anchorNode) placeAnchorNodes.push(anchorNode);
        });
      }
    });
    orderedNodes.push(...playerNodes);
    orderedNodes.push(...placeAnchorNodes);

    return (
      <div
        key={panelKey}
        className={`pixel-world-editor-stage ${interactive ? 'active-loop' : 'loop-copy'} ${showCollisionLines ? 'collision-lines-visible' : ''}`}
        ref={interactive ? stageRef : undefined}
        style={{
          '--editor-zoom': zoom,
          width: `${stageSize.width * zoom}px`,
          height: `${stageSize.height * zoom}px`,
          '--street-bg-color': commercialV2BackgroundColor
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="pixel-world-editor-bg" aria-hidden="true" />
        {orderedNodes}
        {interactive && renderPlayerInteractionMenu()}
      </div>
    );
  }

  const layoutJson = useMemo(() => JSON.stringify({
    segment: {
      width: commercialV2SegmentSize.width,
      height: stageSize.height
    },
    segments: segmentCount,
    stage: stageSize,
    background: {
      type: 'solid',
      color: commercialV2BackgroundColor
    },
    loop: getCommercialV2Loop(stageSize),
    collision: {
      unit: 'ratio-of-item-box',
      mode: 'active',
      lineVisibility: 'hidden-by-default',
      player: 'foot-point',
      groundLayer: 'ignored'
    },
    places: placeLinks,
    items: items.map((item) => serializeCommercialV2Item(item, assetById.get(item.assetId)))
  }, null, 2), [assetById, items, placeLinks, segmentCount, stageSize]);

  return (
    <div className={`pixel-world-editor ${viewMode ? 'view-mode' : ''}`}>
      <div className="pixel-world-editor-toolbar">
        <button onClick={saveLayout}>保存布局</button>
        <button onClick={saveCurrentAsDefaultScene}>保存当前场景为默认场景</button>
        <button onClick={copyLayout}>复制 JSON</button>
        <button
          className={viewMode ? 'active' : ''}
          onClick={toggleViewMode}
          title={viewMode ? '素材已锁定，关闭后才能移动和编辑' : '开启后锁定素材，避免误拖'}
        >
          {viewMode ? '观赏模式' : '编辑模式'}
        </button>
        <button onClick={() => setZoom((value) => Math.max(0.35, Number((value - 0.1).toFixed(2))))}>画布缩小</button>
        <button onClick={() => setZoom((value) => Math.min(1.4, Number((value + 0.1).toFixed(2))))}>画布放大</button>
        <strong>{Math.round(zoom * 100)}%</strong>
        <button onClick={prependCanvasSegment} disabled={!canEditLayout}>左边增加 {commercialV2SegmentSize.width}px</button>
        <button onClick={appendCanvasSegment} disabled={!canEditLayout}>右边增加 {commercialV2SegmentSize.width}px</button>
        <button onClick={removeCanvasSegment} disabled={!canEditLayout || segmentCount <= commercialV2MinSegmentCount}>收回一段</button>
        <strong>{segmentCount} 段</strong>
        <span>首尾相连</span>
        <span className="pixel-world-player-help">WASD 控制当前人物</span>
        <label className="pixel-world-player-switch-control">
          <span>控制角色</span>
          <select
            value={controlledPlayerId}
            onChange={(event) => {
              switchControlledPlayer(event.target.value);
              event.currentTarget.blur();
            }}
            aria-label="切换控制角色"
          >
            {commercialV2PlayerCharacters.map((character) => (
              <option key={character.id} value={character.id}>{character.label}</option>
            ))}
          </select>
          <strong>{controlledPlayerCharacter.label}</strong>
        </label>
        <label className="pixel-world-auto-walk-control">
          <span>自动循迹</span>
          <select
            value={autoTargetId}
            onChange={(event) => setAutoTargetId(event.target.value)}
            disabled={!travelTargetOptions.length}
            aria-label="自动循迹目标"
          >
            {travelTargetOptions.length ? travelTargetOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            )) : (
              <option value="">暂无地点</option>
            )}
          </select>
          <button type="button" onClick={() => startAutoTravel()} disabled={!travelTargetOptions.length}>前往</button>
          <button
            type="button"
            onClick={() => cancelAutoTravel('自动循迹已停止。')}
            disabled={!autoTravelActive && !playerActionBubble}
          >
            停止
          </button>
        </label>
        <label className="pixel-world-player-scale-control">
          <span>角色尺寸</span>
          <input
            type="range"
            min="0.6"
            max="3"
            step="0.05"
            value={playerScale}
            onChange={(event) => updatePlayerScale(event.target.value)}
          />
          <input
            type="number"
            min="0.6"
            max="3"
            step="0.05"
            value={playerScale}
            onChange={(event) => updatePlayerScale(event.target.value)}
            aria-label="角色尺寸倍率"
          />
          <strong>{Math.round(playerScale * 100)}%</strong>
        </label>
        <button onClick={() => setPlayerScale(commercialV2DefaultPlayerScale)}>默认角色尺寸</button>
        <button onClick={() => centerPlayerInView(true)}>居中当前人物</button>
        <button
          className={showCollisionLines ? 'active' : ''}
          onClick={toggleCollisionLines}
          title="只切换碰撞箱线条显示；碰撞阻挡默认一直生效"
        >
          {showCollisionLines ? '隐藏碰撞箱线' : '查看碰撞箱线'}
        </button>
        <button
          className={showPlaceAnchors ? 'active' : ''}
          onClick={togglePlaceAnchors}
          title="查看角色以后自动前往和交互的地点锚点"
        >
          {showPlaceAnchors ? '隐藏地点锚点' : '查看地点锚点'}
        </button>
        <button
          className={showLayerPanel ? 'active' : ''}
          onClick={() => setShowLayerPanel((value) => !value)}
          title="显示统一图层序号和右侧图层列表"
        >
          {showLayerPanel ? '隐藏图层' : '查看图层'}
        </button>
        <button
          className={canEditLayout && groupEditMode ? 'active' : ''}
          onClick={() => setGroupEditMode((value) => !value)}
          disabled={!canEditLayout}
          title="开启后拖动、缩放和微调会作用于全部素材"
        >
          {groupEditMode ? '整体编辑中' : '整体编辑'}
        </button>
        <button onClick={() => scaleSelected(0.92)} disabled={!canEditLayout || (groupEditMode ? items.length === 0 : !selectedItem)}>{groupEditMode ? '整体缩小' : '素材缩小'}</button>
        <button onClick={() => scaleSelected(1.08)} disabled={!canEditLayout || (groupEditMode ? items.length === 0 : !selectedItem)}>{groupEditMode ? '整体放大' : '素材放大'}</button>
        <button onClick={() => moveSelectedLayer('up')} disabled={!canEditLayout || groupEditMode || !selectedItem}>上移图层</button>
        <button onClick={() => moveSelectedLayer('down')} disabled={!canEditLayout || groupEditMode || !selectedItem}>下移图层</button>
        <button onClick={bringSelectedToFront} disabled={!canEditLayout || groupEditMode || !selectedItem}>置顶</button>
        <button onClick={sendSelectedToBack} disabled={!canEditLayout || groupEditMode || !selectedItem}>置底</button>
        <button onClick={deleteSelected} disabled={!canEditLayout || groupEditMode || !selectedItem}>删除</button>
        <button onClick={restoreResetBackup} disabled={!canEditLayout}>恢复上次布局</button>
        <button onClick={resetLayout} disabled={!canEditLayout}>恢复默认</button>
        <span>{notice}</span>
      </div>

      <div className={`pixel-world-editor-body ${behaviorPanelCollapsed ? 'behavior-collapsed' : ''}`}>
        <aside className="pixel-world-asset-panel">
          <h3>素材</h3>
          <div className="pixel-world-asset-type-tabs" role="tablist" aria-label="素材分类">
            {groupedAssets.map(([type, assets]) => (
              <button
                key={type}
                className={activeAssetGroup?.[0] === type ? 'active' : ''}
                onClick={() => setActiveAssetType(type)}
                title={`${type} (${assets.length})`}
              >
                {type}
                <span>{assets.length}</span>
              </button>
            ))}
          </div>
          {activeAssetGroup && (
            <div className="pixel-world-asset-group" key={activeAssetGroup[0]}>
              <strong>{activeAssetGroup[0]}</strong>
              <div className="pixel-world-asset-grid">
                {activeAssetGroup[1].map((asset) => (
                  <button key={asset.id} onClick={() => addAsset(asset)} title={asset.name} disabled={!canEditLayout}>
                    <img src={commercialV2Asset(asset.path)} alt="" draggable={false} loading="lazy" />
                    <span>{asset.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        <div
          className="pixel-world-editor-canvas-wrap"
          ref={canvasWrapRef}
          tabIndex={0}
          onPointerDownCapture={focusCanvasForKeyboard}
          onScroll={onLoopScroll}
          aria-label="商业街画布，点击后可用 WASD 控制当前人物"
        >
          <div className="pixel-world-editor-loop-track">
            {renderEditorPanel('loop-before')}
            {renderEditorPanel('loop-current', true)}
            {renderEditorPanel('loop-after')}
          </div>
        </div>

        <aside className="pixel-world-inspector">
          <h3>选中</h3>
          {viewMode ? (
            <p>观赏模式已开启，素材不会被选中或拖动；切到编辑模式后可以移动素材。</p>
          ) : selectedItem && selectedAsset ? (
            <>
              <div className="pixel-world-selected-name">{selectedAsset.name}</div>
              <div className={`pixel-world-layer-mode-card ${selectedIsGroundLayer ? 'ground' : ''}`}>
                <div className="pixel-world-layer-mode-head">
                  <strong>图层属性</strong>
                  <label className="pixel-world-collision-toggle">
                    <input
                      type="checkbox"
                      checked={selectedIsGroundLayer}
                      disabled={selectedIsBuiltInGroundLayer}
                      onChange={(event) => updateSelectedGroundLayer(event.target.checked)}
                    />
                    <span>地面层</span>
                  </label>
                </div>
                <small>
                  {selectedIsBuiltInGroundLayer
                    ? '这个素材类型固定为背景板，永远在人物下方，碰撞箱不会阻挡人物。'
                    : selectedIsGroundLayer
                      ? '当前实例会恒在人物下方；碰撞箱保留但不会阻挡人物。'
                      : '普通素材会按图层和遮挡判断显示。'}
                </small>
              </div>
              {selectedPlace && (
                <div className="pixel-world-place-card">
                  <div className="pixel-world-place-card-head">
                    <strong>地点联动</strong>
                    {!showPlaceAnchors && (
                      <button onClick={togglePlaceAnchors}>查看终点</button>
                    )}
                  </div>
                  <span>{selectedPlace.name}</span>
                  <small>ID: {selectedPlace.placeId}</small>
                  <small>后端地点: {selectedPlace.locationIds.join(' / ')}</small>
                  <small>动作: {selectedPlace.actions.join(' / ')}</small>
                  {selectedPlaceAnchorLocalPoint && (
                    <>
                      <div className="pixel-world-place-fields">
                        {['x', 'y'].map((key) => (
                          <label key={`place-anchor-${key}`}>
                            <span>{key.toUpperCase()}</span>
                            <input
                              type="number"
                              value={selectedPlaceAnchorLocalPoint[key]}
                              onChange={(event) => updateSelectedPlaceAnchorLocalPoint(key, event.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="pixel-world-collision-actions">
                        <button onClick={resetSelectedPlaceAnchor}>默认终点</button>
                      </div>
                      <div className="pixel-world-inspector-hint">
                        显示终点后，拖粉色点就能改自动循迹落点；保存布局会一起保存。
                      </div>
                    </>
                  )}
                </div>
              )}
              {['x', 'y', 'w', 'h'].map((key) => (
                <label key={key}>
                  <span>{key.toUpperCase()}</span>
                  <input
                    type="number"
                    value={Math.round(selectedItem[key])}
                    onChange={(event) => updateItem(selectedItem.id, { [key]: Number(event.target.value) })}
                  />
                </label>
              ))}
              <div className="pixel-world-nudge-pad" aria-label="微调位置">
                <button onClick={() => nudgeSelected(0, -4)}>↑</button>
                <button onClick={() => nudgeSelected(-4, 0)}>←</button>
                <button onClick={() => nudgeSelected(4, 0)}>→</button>
                <button onClick={() => nudgeSelected(0, 4)}>↓</button>
              </div>
              <div className="pixel-world-scale-row">
                <button onClick={() => scaleSelected(0.96)}>{groupEditMode ? '整体小一点' : '小一点'}</button>
                <button onClick={() => scaleSelected(1.04)}>{groupEditMode ? '整体大一点' : '大一点'}</button>
              </div>
              <div className={`pixel-world-collision-editor ${showCollisionLines ? 'active' : ''}`}>
                <div className="pixel-world-collision-editor-head">
                  <strong>碰撞体积</strong>
                  {!showCollisionLines && (
                    <button onClick={toggleCollisionLines}>查看碰撞箱线</button>
                  )}
                  <label className="pixel-world-collision-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedCollision?.enabled)}
                      disabled={!isCommercialV2CollisionAsset(selectedAsset) || !selectedCollisionCanTakeEffect}
                      onChange={(event) => updateSelectedCollisionEnabled(event.target.checked)}
                    />
                    <span>启用</span>
                  </label>
                </div>
                {selectedCollisionCanTakeEffect && selectedCollisionLocalBox ? (
                  <>
                    <div className="pixel-world-collision-fields">
                      {['x', 'y', 'w', 'h'].map((key) => (
                        <label key={`collision-${key}`}>
                          <span>{key.toUpperCase()}</span>
                          <input
                            type="number"
                            value={selectedCollisionLocalBox[key]}
                            onChange={(event) => updateSelectedCollisionLocalBox(key, event.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="pixel-world-collision-actions">
                      <button onClick={resetSelectedCollision}>默认</button>
                      <button onClick={fitSelectedCollisionToSprite}>贴合整图</button>
                    </div>
                    <div className="pixel-world-inspector-hint">
                      碰撞默认生效；显示线条后，拖绿色框移动碰撞箱，拖蓝色点调整大小。
                    </div>
                  </>
                ) : (
                  <div className="pixel-world-inspector-hint">
                    {selectedIsGroundLayer
                      ? '地面层规则：这个实例的碰撞箱不会参与人物阻挡或自动循迹绕路。'
                      : '这个素材还没有可编辑的碰撞箱。'}
                  </div>
                )}
              </div>
              <div className="pixel-world-inspector-hint">
                {groupEditMode ? '整体编辑已开启：拖动任意素材会带动当前全部建筑和道具。' : '拖动素材移动；用 W/H 调整大小，显示会保持原图比例。'}
              </div>
            </>
          ) : (
            <p>点击画布上的素材开始编辑。</p>
          )}
          {showLayerPanel && (
            <section className="pixel-world-layer-panel">
              <div className="pixel-world-layer-panel-head">
                <strong>图层</strong>
                <small>上方后绘制；背景板恒在人物下方且不参与碰撞。</small>
              </div>
              {selectedLayerRow && (
                <div className="pixel-world-layer-current">
                  当前：{selectedLayerRow.asset?.name || selectedLayerRow.item.assetId}
                  <span>#{selectedLayerRow.layerIndex + 1}</span>
                </div>
              )}
              <div className="pixel-world-layer-list">
                {layerRows.slice().reverse().map((row) => (
                  <button
                    key={`layer-row-${row.item.id}`}
                    type="button"
                    className={`pixel-world-layer-row ${row.item.id === selectedId ? 'active' : ''} ${row.isGround ? 'ground' : 'asset'}`}
                    onClick={() => setSelectedId(row.item.id)}
                    title={`${row.asset?.name || row.item.assetId} / z-index ${row.zIndex}`}
                  >
                    <span className="pixel-world-layer-index">#{row.layerIndex + 1}</span>
                    <span className="pixel-world-layer-name">
                      {row.asset?.name || row.item.assetId}
                      <small>{row.asset?.type || '未知'} · z {row.zIndex} · {row.playerRule}</small>
                    </span>
                    <span className="pixel-world-layer-kind">{row.isGround ? '背景板' : '素材'}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <h3>布局 JSON</h3>
          <textarea value={layoutJson} readOnly />
        </aside>

        {renderBehaviorTreePanel()}
      </div>
    </div>
  );
}

function PixelWorldPanelContent({ apiUrl = '/api', userProfile = null }) {
  const [activeScene, setActiveScene] = useState('street');
  const [activeRoomStyle, setActiveRoomStyle] = useState('cute');
  const scene = activeScene === 'room' ? roomScenes[activeRoomStyle] : scenes.street;

  return (
    <div className="pixel-world-page">
      <style>{styles}</style>
      <div className="pixel-world-header">
        <div>
          <div className="pixel-world-kicker">Pixel Implementation</div>
          <h2>像素实装模块</h2>
          <p>{scene.subtitle}</p>
        </div>
        <div className="pixel-world-tabs" role="tablist" aria-label="像素场景">
          <button className={activeScene === 'street' ? 'active' : ''} onClick={() => setActiveScene('street')}>商业街</button>
          <button className={activeScene === 'room' ? 'active' : ''} onClick={() => setActiveScene('room')}>居住房间</button>
        </div>
      </div>

      {activeScene === 'room' && (
        <div className="pixel-world-style-tabs" role="tablist" aria-label="房间风格">
          {Object.entries(roomStyleMeta).map(([key, meta]) => (
            <button
              key={key}
              className={activeRoomStyle === key ? 'active' : ''}
              onClick={() => setActiveRoomStyle(key)}
            >
              {meta.label}
            </button>
          ))}
        </div>
      )}

      {activeScene === 'street' ? (
        <CommercialStreetEditor apiUrl={apiUrl} userProfile={userProfile} />
      ) : (
        <div className="pixel-world-main">
          <section className="pixel-world-scene-panel">
            <div className="pixel-world-scene-title">
              <div>
                <h3>{scene.title}</h3>
                <span>{scene.source}</span>
              </div>
              <div className="pixel-world-live">Prototype</div>
            </div>
            <Scene scene={scene} />
            {scene.referenceImage && (
              <div className="pixel-world-reference-strip">
                <div>
                  <strong>AI 摆放参考</strong>
                  <span>按空房型和规划框生成，只作为比例、角度、拥挤度参考。</span>
                </div>
                <img src={scene.referenceImage} alt="AI 摆放参考图" />
              </div>
            )}
          </section>

          <aside className="pixel-world-side">
            <div className="pixel-world-card">
              <h3>联动预留</h3>
              <div className="pixel-world-list">
                {scene.notes.map((note) => <div key={note}>{note}</div>)}
              </div>
            </div>
          {scene.agents.length > 0 && (
            <div className="pixel-world-card">
              <h3>角色投影</h3>
                {scene.agents.map((agent) => (
                  <div className="pixel-world-agent-row" key={agent.id}>
                    {agent.look ? <Chibi small look={agent.look} /> : <img src={tile(agent.tile)} alt="" />}
                    <div>
                      <strong>{agent.name}</strong>
                      <span>{agent.status}</span>
                    </div>
                  </div>
                ))}
            </div>
          )}
          {scene.layoutObjects?.length > 0 && (
            <div className="pixel-world-card muted">
              <h3>拼接规则</h3>
              <p>家具素材必须按占位框贴入：用 anchor 对齐脚点或墙点，用 facing 选择朝向，用 collision 生成不可走区域。</p>
              <div className="pixel-world-rule-list">
                {scene.layoutObjects.slice(0, 6).map((item) => (
                  <div key={item.id}>
                    <strong>{item.name}</strong>
                    <span>{item.w}x{item.h} / {item.anchor} / {item.facing}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="pixel-world-card muted">
              <h3>素材来源</h3>
              <p>{scene.assetNote}</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

class PixelWorldErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[PixelWorld] module crashed', error, info);
  }

  retry = () => {
    this.setState({ error: null });
  };

  clearPixelWorldCache = () => {
    [
      commercialV2StorageKey,
      commercialV2CanvasStorageKey,
      commercialV2ResetBackupStorageKey,
      commercialV2DefaultSnapshotStorageKey,
      commercialV2BehaviorConfigStorageKey
    ].forEach((key) => localStorage.removeItem(key));
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pixel-world-page">
        <style>{styles}</style>
        <div className="pixel-world-crash-card">
          <div className="pixel-world-kicker">Pixel Implementation</div>
          <h2>像素实装模块没有正常打开</h2>
          <p>模块入口已经拦截住这次崩溃了。可以先重试；如果还是打不开，清理商业街本地布局缓存后会恢复默认布局。</p>
          <div className="pixel-world-crash-actions">
            <button onClick={this.retry}>重试打开</button>
            <button onClick={this.clearPixelWorldCache}>清理布局缓存</button>
          </div>
          <pre>{String(this.state.error?.message || this.state.error || 'Unknown error')}</pre>
        </div>
      </div>
    );
  }
}

export default function PixelWorldPanel(props) {
  return (
    <PixelWorldErrorBoundary>
      <PixelWorldPanelContent {...props} />
    </PixelWorldErrorBoundary>
  );
}

const styles = `
.pixel-world-page {
  min-height: 100%;
  padding: 18px;
  background:
    linear-gradient(180deg, #fff4fb 0%, #f2fbff 48%, #f7fff3 100%);
  color: #4f4050;
}
.pixel-world-header {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-end;
  margin-bottom: 18px;
}
.pixel-world-kicker {
  font-size: 12px;
  color: #df6fa3;
  font-weight: 800;
  text-transform: uppercase;
}
.pixel-world-header h2 {
  margin: 4px 0 6px;
  font-size: 26px;
  line-height: 1.1;
  letter-spacing: 0;
}
.pixel-world-header p {
  margin: 0;
  color: #8a7488;
  font-size: 14px;
}
.pixel-world-crash-card {
  max-width: 680px;
  margin: 56px auto;
  padding: 24px;
  border: 1px solid rgba(223, 111, 163, 0.24);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 18px 42px rgba(117, 80, 104, 0.14);
}
.pixel-world-crash-card h2 {
  margin: 4px 0 10px;
  color: #4c3243;
}
.pixel-world-crash-card p {
  margin: 0 0 16px;
  line-height: 1.7;
  color: #6d5b67;
}
.pixel-world-crash-card pre {
  max-height: 160px;
  overflow: auto;
  margin: 16px 0 0;
  padding: 12px;
  border-radius: 8px;
  background: #fff5f8;
  color: #9a345b;
  white-space: pre-wrap;
  font-size: 12px;
}
.pixel-world-crash-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.pixel-world-crash-actions button {
  border: 0;
  border-radius: 8px;
  padding: 10px 14px;
  background: #f58bb8;
  color: #fff;
  font-weight: 800;
  cursor: pointer;
}
.pixel-world-crash-actions button + button {
  background: #6c7fd9;
}
.pixel-world-tabs {
  display: flex;
  gap: 8px;
  padding: 5px;
  background: #ffffff;
  border: 1px solid #f6cfe1;
  border-radius: 8px;
}
.pixel-world-tabs button {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #8b6a83;
  padding: 9px 13px;
  font-weight: 700;
  cursor: pointer;
}
.pixel-world-tabs button.active {
  background: #f58bb8;
  color: #fff;
}
.pixel-world-style-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: -6px 0 18px;
}
.pixel-world-style-tabs button {
  border: 1px solid #f3c9de;
  border-radius: 7px;
  background: #fffafd;
  color: #8b6a83;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
}
.pixel-world-style-tabs button.active {
  border-color: #e986b6;
  background: #f58bb8;
  color: #fff;
  box-shadow: 0 8px 18px rgba(221, 112, 162, .18);
}
.pixel-world-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 14px;
  align-items: start;
}
.pixel-world-scene-panel,
.pixel-world-card {
  background: #ffffff;
  border: 1px solid #f5d5e4;
  border-radius: 8px;
  box-shadow: 0 16px 40px rgba(196, 116, 159, 0.12);
}
.pixel-world-scene-panel {
  overflow: hidden;
}
.pixel-world-scene-title {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid #f7dce9;
}
.pixel-world-scene-title h3,
.pixel-world-card h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.25;
}
.pixel-world-scene-title span {
  display: block;
  margin-top: 4px;
  color: #9b8496;
  font-size: 12px;
}
.pixel-world-live {
  background: #fff0f8;
  color: #d45893;
  border: 1px solid #ffc6df;
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 800;
}
.pixel-world-stage-wrap {
  display: flex;
  justify-content: center;
  padding: 28px 22px 34px;
  overflow: auto;
  min-height: min(68vh, 760px);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0)),
    #fde9f3;
}
.pixel-world-stage {
  --tile: clamp(28px, 2.35vw, 46px);
  position: relative;
  width: calc(var(--cols) * var(--tile));
  height: calc(var(--rows) * var(--tile));
  margin: auto;
  image-rendering: pixelated;
  border: calc(var(--tile) * 0.18) solid #b59bd7;
  box-shadow: 0 20px 0 rgba(178, 139, 197, 0.16), 0 24px 38px rgba(190, 117, 162, 0.22);
  background: #bde5c4;
  overflow: hidden;
}
.pixel-world-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  image-rendering: pixelated;
  user-select: none;
}
.pixel-world-reference-strip {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  padding: 14px 16px 18px;
  border-top: 1px solid #f5cfe1;
  background: linear-gradient(180deg, #fff8fc, #fff);
}
.pixel-world-reference-strip strong {
  display: block;
  margin-bottom: 5px;
  color: #4f4050;
  font-size: 14px;
}
.pixel-world-reference-strip span {
  display: block;
  color: #9b8496;
  font-size: 12px;
  line-height: 1.55;
}
.pixel-world-reference-strip img {
  width: 100%;
  max-height: 360px;
  object-fit: contain;
  image-rendering: pixelated;
  border: 1px solid #f0c7dc;
  background: #111;
}
.pixel-world-grid {
  display: grid;
  grid-template-columns: repeat(var(--cols), var(--tile));
  grid-template-rows: repeat(var(--rows), var(--tile));
  width: 100%;
  height: 100%;
}
.pixel-world-tile {
  width: var(--tile);
  height: var(--tile);
  object-fit: fill;
  image-rendering: pixelated;
  user-select: none;
  filter: saturate(.82) brightness(1.12) hue-rotate(5deg);
}
.pixel-world-shadow-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg, rgba(255,255,255,0.16), transparent 34%),
    radial-gradient(circle at 78% 18%, rgba(255,220,241,0.34), transparent 28%);
  mix-blend-mode: soft-light;
}
.pixel-world-building,
.pixel-world-rug,
.pixel-world-zone,
.pixel-world-room-frame,
.pixel-world-furniture,
.pixel-world-layout-zone,
.pixel-world-layout-object,
.pixel-world-sprite,
.pixel-world-agent {
  position: absolute;
  left: calc(var(--x) * var(--tile));
  top: calc(var(--y) * var(--tile));
}
.pixel-world-building {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  border: 2px solid rgba(64, 57, 73, 0.45);
  background: #fff2f6;
  box-shadow: 0 calc(var(--tile) * .18) 0 rgba(0,0,0,.18);
}
.pixel-world-building-roof {
  height: calc(var(--tile) * 0.9);
  background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.16) 0 5px, transparent 5px 12px),
    var(--roof);
  border-bottom: 2px solid rgba(55, 48, 61, 0.28);
}
.pixel-world-building-body {
  height: calc(100% - var(--tile) * 0.9);
  background:
    linear-gradient(90deg, transparent 0 12%, var(--trim) 12% 20%, transparent 20% 80%, var(--trim) 80% 88%, transparent 88%),
    #fff7e7;
  display: grid;
  align-content: center;
  justify-content: center;
  gap: 3px;
}
.pixel-world-window-row,
.pixel-world-door-row {
  display: flex;
  gap: 3px;
  justify-content: center;
}
.pixel-world-building .pixel-world-tile,
.pixel-world-window-row img,
.pixel-world-door-row img {
  width: calc(var(--tile) * 0.86);
  height: calc(var(--tile) * 0.86);
}
.pixel-world-building-name {
  position: absolute;
  left: 6px;
  bottom: 4px;
  background: rgba(111, 84, 128, 0.82);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 4px;
}
.pixel-world-rug {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  background:
    linear-gradient(90deg, transparent 0 8%, rgba(255,255,255,.3) 8% 14%, transparent 14%),
    #f4a7bd;
  border: 2px solid #d783a5;
  box-shadow: inset 0 0 0 3px rgba(255, 231, 205, .45);
}
.pixel-world-zone {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  border: 1px dashed rgba(76, 91, 110, .28);
  background: rgba(255,255,255,.16);
  pointer-events: none;
}
.pixel-world-zone span {
  position: absolute;
  left: 5px;
  top: 4px;
  background: rgba(255,255,255,.82);
  color: #8b6b84;
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 3px;
}
.pixel-world-layout-zone {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  box-sizing: border-box;
  z-index: 3;
  border: 1px dashed rgba(118, 92, 145, .38);
  background: rgba(255, 255, 255, .13);
  pointer-events: none;
}
.pixel-world-layout-zone.entry-path {
  background: rgba(180, 226, 255, .16);
  border-color: rgba(84, 148, 188, .42);
}
.pixel-world-layout-zone.blocked {
  background:
    repeating-linear-gradient(
      -45deg,
      rgba(255, 112, 156, .16) 0,
      rgba(255, 112, 156, .16) 6px,
      rgba(255, 255, 255, .08) 6px,
      rgba(255, 255, 255, .08) 12px
    );
  border-color: rgba(214, 94, 137, .55);
}
.pixel-world-layout-zone.blocked span {
  color: #b34c78;
  border-color: rgba(214, 94, 137, .45);
}
.pixel-world-layout-zone span {
  position: absolute;
  left: 6px;
  top: 5px;
  background: rgba(255,255,255,.88);
  border: 1px solid rgba(238, 182, 211, .86);
  border-radius: 4px;
  color: #8b6b84;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  white-space: nowrap;
}
.pixel-world-layout-object {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  box-sizing: border-box;
  z-index: 10;
  border: 2px solid rgba(194, 91, 139, .72);
  background:
    linear-gradient(135deg, rgba(255,255,255,.22), transparent 44%),
    rgba(245, 139, 184, .32);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.42),
    0 calc(var(--tile) * .12) 0 rgba(111, 83, 130, .16);
  pointer-events: none;
}
.pixel-world-layout-object.large {
  border-color: rgba(174, 104, 210, .74);
  background: rgba(190, 146, 229, .28);
}
.pixel-world-layout-object.floor {
  z-index: 4;
  border-color: rgba(230, 128, 170, .55);
  background: rgba(255, 180, 210, .22);
}
.pixel-world-layout-object.wall {
  z-index: 11;
  border-style: dashed;
  background: rgba(255, 244, 182, .34);
}
.pixel-world-layout-object.decor {
  border-color: rgba(109, 184, 143, .7);
  background: rgba(157, 220, 184, .26);
}
.pixel-world-layout-object span {
  position: absolute;
  left: 50%;
  bottom: 50%;
  transform: translate(-50%, 50%);
  background: rgba(255,255,255,.92);
  border: 1px solid #f3c9da;
  color: #75566f;
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
.pixel-world-layout-object .anchor {
  position: absolute;
  width: 8px;
  height: 8px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #d45893;
  box-shadow: 0 0 0 1px rgba(106, 70, 112, .38);
}
.pixel-world-layout-object .anchor.bottom-center {
  left: 50%;
  bottom: -5px;
  transform: translateX(-50%);
}
.pixel-world-layout-object .anchor.center {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.pixel-world-layout-object .anchor.wall-center {
  left: 50%;
  top: -5px;
  transform: translateX(-50%);
}
.pixel-world-layout-object .facing {
  position: absolute;
  right: 5px;
  top: 5px;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 8px solid rgba(95, 70, 122, .78);
}
.pixel-world-layout-object .facing.south {
  transform: rotate(180deg);
}
.pixel-world-layout-object .facing.east {
  transform: rotate(90deg);
}
.pixel-world-layout-object .facing.west {
  transform: rotate(-90deg);
}
.pixel-world-layout-object em {
  position: absolute;
  left: 5px;
  bottom: 5px;
  font-style: normal;
  color: rgba(96, 76, 104, .82);
  font-size: 9px;
  line-height: 1;
}
.pixel-world-room-frame {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  box-sizing: border-box;
  pointer-events: none;
  border: calc(var(--tile) * .34) solid #c8b0de;
  box-shadow:
    inset 0 0 0 2px rgba(255,255,255,.5),
    inset 0 0 0 calc(var(--tile) * .55) rgba(255, 238, 248, .52);
  z-index: 2;
}
.pixel-world-room-frame span {
  position: absolute;
  left: calc(var(--tile) * .6);
  top: calc(var(--tile) * .45);
  color: #9a7090;
  background: rgba(255,255,255,.86);
  border: 1px solid rgba(238, 182, 211, .8);
  border-radius: 4px;
  font-size: 10px;
  padding: 2px 5px;
}
.pixel-world-furniture {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  box-sizing: border-box;
  z-index: 8;
  border: 2px solid rgba(99, 82, 110, .32);
  box-shadow: 0 calc(var(--tile) * .16) 0 rgba(144, 92, 132, .16);
}
.pixel-world-furniture span {
  position: absolute;
  left: 50%;
  bottom: -1px;
  transform: translate(-50%, 50%);
  background: rgba(255,255,255,.9);
  border: 1px solid #f3c9da;
  color: #8b5e7f;
  border-radius: 4px;
  padding: 2px 5px;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
.pixel-world-furniture.bed {
  background:
    linear-gradient(90deg, #ffd3e4 0 24%, #fff7fb 24% 100%),
    #fff7fb;
  box-shadow:
    inset 0 calc(var(--tile) * .3) 0 #ff9fc6,
    inset calc(var(--tile) * .32) calc(var(--tile) * .62) 0 #fff0a8,
    0 calc(var(--tile) * .16) 0 rgba(144, 92, 132, .16);
}
.pixel-world-furniture.desk {
  background:
    linear-gradient(#ffc17e 0 22%, transparent 22%),
    linear-gradient(90deg, transparent 0 18%, #b77955 18% 82%, transparent 82%),
    #f2d2b0;
}
.pixel-world-furniture.kitchen {
  background:
    linear-gradient(90deg, #fff6fb 0 18%, transparent 18% 82%, #fff6fb 82%),
    repeating-linear-gradient(90deg, #f5aacb 0 20%, #ffd5e8 20% 40%);
}
.pixel-world-furniture.kitchen::before {
  content: '';
  position: absolute;
  left: 10%;
  right: 10%;
  top: 18%;
  height: 24%;
  background: #9fd2c0;
  border: 2px solid rgba(82, 94, 108, .32);
}
.pixel-world-furniture.sofa {
  background:
    linear-gradient(#ffe5c7 0 34%, #ffc5dc 34% 70%, #f3a3c5 70%),
    #ffc5dc;
}
.pixel-world-furniture.table {
  background:
    radial-gradient(circle at 50% 38%, #ffecc6 0 30%, transparent 31%),
    #bd7d5d;
  border-radius: 3px;
}
.pixel-world-furniture.plant {
  width: calc(var(--tile) * 1.1);
  background:
    radial-gradient(circle at 38% 30%, #8fd69c 0 18%, transparent 19%),
    radial-gradient(circle at 62% 28%, #78c78d 0 18%, transparent 19%),
    linear-gradient(#9ed9b5 0 42%, #f4a7bd 42% 100%);
}
.pixel-world-furniture.door {
  background:
    linear-gradient(90deg, transparent 0 18%, #f7c48d 18% 82%, transparent 82%),
    #c7966f;
}
.pixel-world-sprite {
  width: calc(var(--w) * var(--tile));
  height: calc(var(--h) * var(--tile));
  object-fit: contain;
  object-position: center bottom;
  image-rendering: pixelated;
  filter: saturate(.85) brightness(1.12) hue-rotate(6deg) drop-shadow(0 3px 0 rgba(161, 94, 137, .18));
}
.pixel-world-agent {
  transform: translate(-10%, -34%);
  z-index: 12;
  display: grid;
  justify-items: center;
  gap: 2px;
  filter: saturate(.9) brightness(1.1) hue-rotate(6deg) drop-shadow(0 3px 0 rgba(153, 93, 137, .2));
}
.pixel-world-agent img {
  width: calc(var(--tile) * 1.05);
  height: calc(var(--tile) * 1.05);
  image-rendering: pixelated;
}
.pixel-world-chibi {
  position: relative;
  width: calc(var(--tile) * 1.05);
  height: calc(var(--tile) * 1.18);
  image-rendering: pixelated;
}
.pixel-world-chibi.small {
  --tile: 28px;
  width: 28px;
  height: 31px;
  flex: 0 0 auto;
}
.pixel-world-chibi i {
  position: absolute;
  display: block;
  image-rendering: pixelated;
}
.pixel-world-chibi .hair {
  left: 24%;
  top: 4%;
  width: 52%;
  height: 38%;
  background: var(--hair);
  border-radius: 45% 45% 24% 24%;
  box-shadow:
    calc(var(--tile) * -.11) calc(var(--tile) * .17) 0 var(--hair),
    calc(var(--tile) * .11) calc(var(--tile) * .17) 0 var(--hair);
}
.pixel-world-chibi .face {
  left: 30%;
  top: 22%;
  width: 40%;
  height: 30%;
  background: #ffd8b8;
  border-radius: 32%;
  box-shadow:
    calc(var(--tile) * -.05) calc(var(--tile) * .13) 0 #ffd8b8,
    calc(var(--tile) * .05) calc(var(--tile) * .13) 0 #ffd8b8;
}
.pixel-world-chibi .face::before,
.pixel-world-chibi .face::after {
  content: '';
  position: absolute;
  top: 43%;
  width: 12%;
  height: 12%;
  background: #5b4562;
  border-radius: 1px;
}
.pixel-world-chibi .face::before {
  left: 25%;
}
.pixel-world-chibi .face::after {
  right: 25%;
}
.pixel-world-chibi .body {
  left: 26%;
  top: 50%;
  width: 48%;
  height: 32%;
  background:
    linear-gradient(90deg, var(--accent) 0 18%, var(--outfit) 18% 82%, var(--accent) 82%);
  border-radius: 18% 18% 8% 8%;
}
.pixel-world-chibi .body::before {
  content: '';
  position: absolute;
  left: 38%;
  top: 0;
  width: 24%;
  height: 35%;
  background: rgba(255,255,255,.72);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
.pixel-world-chibi .legs {
  left: 31%;
  top: 78%;
  width: 38%;
  height: 16%;
  background: #5d5277;
  box-shadow:
    calc(var(--tile) * -.09) 0 0 #5d5277,
    calc(var(--tile) * .09) 0 0 #5d5277;
}
.pixel-world-agent span {
  background: rgba(130, 92, 145, .82);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  white-space: nowrap;
}
.pixel-world-bubble {
  background: #fff5c8;
  border: 1px solid #f1c0d5;
  color: #85506e;
  box-shadow: 0 2px 0 rgba(89, 61, 23, .12);
  font-size: 10px;
  line-height: 1.1;
  padding: 4px 6px;
  border-radius: 5px;
  white-space: nowrap;
  opacity: .95;
}
.streetWalkA {
  animation: streetWalkA 7.6s ease-in-out infinite;
}
.streetWalkB {
  animation: streetWalkB 9s ease-in-out infinite;
}
.roomWalkA {
  animation: roomWalkA 6.2s ease-in-out infinite;
}
@keyframes streetWalkA {
  0%, 100% { transform: translate(-10%, -34%) translateX(0); }
  45% { transform: translate(-10%, -34%) translateX(calc(var(--tile) * 2.2)); }
  70% { transform: translate(-10%, -34%) translate(calc(var(--tile) * 2.2), calc(var(--tile) * -1)); }
}
@keyframes streetWalkB {
  0%, 100% { transform: translate(-10%, -34%) translateX(0); }
  50% { transform: translate(-10%, -34%) translateX(calc(var(--tile) * -2.8)); }
}
@keyframes roomWalkA {
  0%, 100% { transform: translate(-10%, -34%) translateX(0); }
  50% { transform: translate(-10%, -34%) translate(calc(var(--tile) * 1.4), calc(var(--tile) * -1.2)); }
}
.pixel-world-side {
  display: grid;
  gap: 14px;
}
.pixel-world-card {
  padding: 14px;
}
.pixel-world-card.muted {
  background: #fffafd;
}
.pixel-world-card p {
  margin: 9px 0 0;
  color: #8a7488;
  font-size: 13px;
  line-height: 1.55;
}
.pixel-world-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
.pixel-world-list div {
  border: 1px solid #f5d5e4;
  background: #fffafd;
  border-radius: 6px;
  padding: 9px 10px;
  color: #7d647a;
  font-size: 13px;
  line-height: 1.45;
}
.pixel-world-rule-list {
  display: grid;
  gap: 7px;
  margin-top: 11px;
}
.pixel-world-rule-list div {
  display: grid;
  gap: 3px;
  border: 1px solid #f4d7e4;
  border-radius: 6px;
  background: #fffafd;
  padding: 8px 9px;
}
.pixel-world-rule-list strong {
  color: #60475c;
  font-size: 12px;
}
.pixel-world-rule-list span {
  color: #967d91;
  font-size: 11px;
}
.pixel-world-agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 9px;
  background: #fffafd;
  border: 1px solid #f5d5e4;
  border-radius: 6px;
}
.pixel-world-agent-row img {
  width: 28px;
  height: 28px;
  image-rendering: pixelated;
}
.pixel-world-agent-row strong {
  display: block;
  font-size: 13px;
  color: #60475c;
}
.pixel-world-agent-row span {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #967d91;
}
.pixel-world-editor {
  display: grid;
  gap: 12px;
}
.pixel-world-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px;
  background: #fff;
  border: 1px solid #f5d5e4;
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(196, 116, 159, 0.1);
}
.pixel-world-editor-toolbar button,
.pixel-world-asset-grid button {
  border: 1px solid #efd1df;
  background: #fffafd;
  color: #75546e;
  border-radius: 7px;
  cursor: pointer;
  font-weight: 800;
}
.pixel-world-editor-toolbar button {
  padding: 8px 11px;
  font-size: 12px;
}
.pixel-world-editor-toolbar button.active {
  border-color: #d45893;
  background: #f58bb8;
  color: #fff;
}
.pixel-world-editor-toolbar button:disabled,
.pixel-world-asset-grid button:disabled {
  opacity: .45;
  cursor: not-allowed;
}
.pixel-world-editor-toolbar span {
  color: #8a7488;
  font-size: 12px;
}
.pixel-world-editor-toolbar strong {
  min-width: 42px;
  color: #d45893;
  font-size: 12px;
  text-align: center;
}
.pixel-world-editor-body {
  display: grid;
  grid-template-columns: 220px minmax(520px, 1fr) 230px 360px;
  gap: 12px;
  align-items: stretch;
}
.pixel-world-editor-body.behavior-collapsed {
  grid-template-columns: 220px minmax(760px, 1fr) 230px 58px;
}
.pixel-world-asset-panel,
.pixel-world-inspector,
.pixel-world-behavior-panel {
  background: #fff;
  border: 1px solid #f5d5e4;
  border-radius: 8px;
  padding: 12px;
  box-sizing: border-box;
  min-height: 0;
  height: 100%;
  overflow: auto;
  box-shadow: 0 12px 28px rgba(196, 116, 159, 0.1);
}
.pixel-world-asset-panel h3,
.pixel-world-inspector h3,
.pixel-world-behavior-panel h3 {
  margin: 0 0 10px;
  color: #60475c;
  font-size: 14px;
}
.pixel-world-asset-type-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.pixel-world-asset-type-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid #efd1df;
  background: #fffafd;
  color: #75546e;
  border-radius: 7px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 800;
}
.pixel-world-asset-type-tabs button.active {
  border-color: #d45893;
  background: #f58bb8;
  color: #fff;
}
.pixel-world-asset-type-tabs span {
  opacity: .72;
  font-size: 10px;
}
.pixel-world-asset-group {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
}
.pixel-world-asset-group strong {
  color: #9a7090;
  font-size: 12px;
}
.pixel-world-asset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.pixel-world-asset-grid button {
  display: grid;
  gap: 5px;
  justify-items: center;
  padding: 7px 5px;
  min-height: 90px;
}
.pixel-world-asset-grid img {
  max-width: 76px;
  max-height: 54px;
  object-fit: contain;
  image-rendering: pixelated;
}
.pixel-world-asset-grid span {
  font-size: 11px;
  line-height: 1.2;
}
.pixel-world-editor-canvas-wrap {
  position: relative;
  overflow: auto;
  padding: 14px;
  background: #fff;
  border: 1px solid #f5d5e4;
  border-radius: 8px;
  box-sizing: border-box;
  min-height: 0;
  box-shadow: 0 12px 28px rgba(196, 116, 159, 0.1);
}
.pixel-world-editor-canvas-wrap:focus {
  outline: 2px solid rgba(53, 166, 255, .32);
  outline-offset: 2px;
}
.pixel-world-editor-loop-track {
  display: flex;
  width: max-content;
  border: 4px solid #a98fc5;
  image-rendering: pixelated;
  touch-action: none;
}
.pixel-world-editor-stage {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
  margin: 0;
  overflow: hidden;
  background: #d2c6bb;
  image-rendering: pixelated;
  touch-action: none;
}
.pixel-world-editor-stage.collision-lines-visible {
  background:
    linear-gradient(rgba(51, 181, 118, .1) 1px, transparent 1px),
    linear-gradient(90deg, rgba(51, 181, 118, .1) 1px, transparent 1px),
    #d2c6bb;
  background-size: 64px 64px;
}
.pixel-world-editor-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: var(--street-bg-color);
  user-select: none;
  pointer-events: none;
}
.pixel-world-editor-item {
  position: absolute;
  display: grid;
  place-items: end center;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  cursor: grab;
  touch-action: none;
  overflow: visible;
}
.pixel-world-editor-item:active {
  cursor: grabbing;
}
.pixel-world-editor-item.loop-ghost {
  cursor: grab;
  opacity: .98;
}
.pixel-world-editor-item.loop-ghost:active {
  cursor: grabbing;
}
.pixel-world-editor.view-mode .pixel-world-editor-item,
.pixel-world-editor.view-mode .pixel-world-editor-item:active,
.pixel-world-editor.view-mode .pixel-world-editor-item.loop-ghost,
.pixel-world-editor.view-mode .pixel-world-editor-item.loop-ghost:active {
  cursor: default;
}
.pixel-world-editor-item.selected {
  border-color: #35a6ff;
  outline: 2px solid rgba(53, 166, 255, .35);
  background: rgba(53, 166, 255, .08);
}
.pixel-world-editor-item.group-bound {
  outline: 1px dashed rgba(212, 88, 147, .42);
  outline-offset: 2px;
}
.pixel-world-editor-item.group-bound.selected {
  outline: 2px solid rgba(212, 88, 147, .46);
  border-color: #d45893;
  background: rgba(212, 88, 147, .08);
}
.pixel-world-editor-item img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center bottom;
  image-rendering: pixelated;
  pointer-events: none;
  user-select: none;
}
.pixel-world-layer-badge {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 4;
  min-width: 18px;
  padding: 3px 5px;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, .78);
  border-radius: 6px;
  background: rgba(96, 71, 92, .82);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  font-weight: 900;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(71, 48, 69, .18);
}
.pixel-world-layer-badge.ground {
  background: rgba(51, 181, 118, .86);
}
.pixel-world-collision-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid rgba(51, 181, 118, .86);
  background: rgba(51, 181, 118, .16);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .72) inset;
  pointer-events: none;
}
.pixel-world-collision-box.selected {
  border-color: rgba(45, 133, 230, .95);
  background: rgba(45, 133, 230, .18);
}
.pixel-world-collision-box.editable {
  pointer-events: auto;
  cursor: move;
  touch-action: none;
}
.pixel-world-collision-handle {
  position: absolute;
  z-index: 2;
  width: 10px;
  height: 10px;
  border: 2px solid #fff;
  border-radius: 999px;
  background: #2d85e6;
  box-shadow: 0 2px 7px rgba(54, 75, 122, .24);
  pointer-events: auto;
}
.pixel-world-collision-handle.handle-nw {
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  cursor: nwse-resize;
}
.pixel-world-collision-handle.handle-n {
  left: 50%;
  top: 0;
  transform: translate(-50%, -50%);
  cursor: ns-resize;
}
.pixel-world-collision-handle.handle-ne {
  right: 0;
  top: 0;
  transform: translate(50%, -50%);
  cursor: nesw-resize;
}
.pixel-world-collision-handle.handle-e {
  right: 0;
  top: 50%;
  transform: translate(50%, -50%);
  cursor: ew-resize;
}
.pixel-world-collision-handle.handle-se {
  right: 0;
  bottom: 0;
  transform: translate(50%, 50%);
  cursor: nwse-resize;
}
.pixel-world-collision-handle.handle-s {
  left: 50%;
  bottom: 0;
  transform: translate(-50%, 50%);
  cursor: ns-resize;
}
.pixel-world-collision-handle.handle-sw {
  left: 0;
  bottom: 0;
  transform: translate(-50%, 50%);
  cursor: nesw-resize;
}
.pixel-world-collision-handle.handle-w {
  left: 0;
  top: 50%;
  transform: translate(-50%, -50%);
  cursor: ew-resize;
}
.pixel-world-place-anchor {
  position: absolute;
  width: 13px;
  height: 13px;
  transform: translate(-50%, -50%);
  border: 2px solid rgba(255, 255, 255, .92);
  border-radius: 999px;
  background: #d45893;
  box-shadow: 0 0 0 2px rgba(212, 88, 147, .32), 0 3px 8px rgba(70, 40, 60, .22);
  pointer-events: none;
}
.pixel-world-place-anchor.editable {
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
}
.pixel-world-place-anchor.editable:active {
  cursor: grabbing;
}
.pixel-world-place-anchor.selected {
  background: #35a6ff;
  box-shadow: 0 0 0 3px rgba(53, 166, 255, .28), 0 3px 8px rgba(70, 40, 60, .22);
}
.pixel-world-place-anchor.manual {
  border-color: #fff5c8;
  box-shadow: 0 0 0 3px rgba(245, 139, 184, .34), 0 3px 8px rgba(70, 40, 60, .22);
}
.pixel-world-place-anchor span {
  position: absolute;
  left: 50%;
  bottom: 15px;
  transform: translateX(-50%);
  max-width: 96px;
  padding: 3px 6px;
  border: 1px solid #efd1df;
  border-radius: 999px;
  background: rgba(255, 250, 253, .94);
  color: #75546e;
  font-size: 10px;
  font-weight: 900;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 4px 10px rgba(196, 116, 159, .12);
}
.pixel-world-player {
  position: absolute;
  object-fit: contain;
  object-position: center bottom;
  image-rendering: pixelated;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 4px 0 rgba(85, 56, 72, .16));
  will-change: transform;
  backface-visibility: hidden;
}
.pixel-world-player.controlled {
  filter: drop-shadow(0 0 0 rgba(255, 255, 255, 1)) drop-shadow(0 0 5px rgba(245, 177, 48, .78)) drop-shadow(0 4px 0 rgba(85, 56, 72, .16));
}
.pixel-world-player.role-actor {
  filter: drop-shadow(0 0 4px rgba(75, 132, 214, .42)) drop-shadow(0 4px 0 rgba(85, 56, 72, .16));
}
.pixel-world-player.user-actor {
  filter: drop-shadow(0 0 4px rgba(58, 159, 117, .42)) drop-shadow(0 4px 0 rgba(85, 56, 72, .16));
}
.pixel-world-player.user-actor.controlled {
  filter: drop-shadow(0 0 0 rgba(255, 255, 255, 1)) drop-shadow(0 0 5px rgba(245, 177, 48, .78)) drop-shadow(0 0 4px rgba(58, 159, 117, .42)) drop-shadow(0 4px 0 rgba(85, 56, 72, .16));
}
.pixel-world-player-nameplate {
  position: absolute;
  transform: translate(-50%, -100%);
  padding: 3px 6px;
  border: 1px solid rgba(255, 255, 255, .86);
  border-radius: 6px;
  color: #fff;
  font-size: 10px;
  font-weight: 900;
  line-height: 1;
  box-shadow: 0 4px 10px rgba(70, 40, 60, .18);
  pointer-events: none;
  white-space: nowrap;
}
.pixel-world-player-nameplate.role-actor {
  background: rgba(75, 132, 214, .92);
}
.pixel-world-player-nameplate.user-actor {
  background: rgba(58, 159, 117, .92);
}
.pixel-world-player-action-bubble {
  position: absolute;
  transform: translate(-50%, -100%);
  min-width: 96px;
  max-width: min(280px, 34vw);
  padding: 7px 10px;
  border: 1px solid rgba(212, 88, 147, .42);
  border-radius: 8px;
  background: rgba(255, 250, 253, .94);
  color: #75546e;
  font-size: 11px;
  font-weight: 900;
  line-height: 1.35;
  text-align: center;
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  word-break: break-word;
  box-shadow: 0 5px 12px rgba(84, 52, 74, .16);
  pointer-events: none;
}
.pixel-world-player-footprint {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid rgba(245, 177, 48, .95);
  background: rgba(245, 177, 48, .22);
  border-radius: 999px;
  pointer-events: none;
}
.pixel-world-player-footprint.controlled {
  border-color: rgba(212, 88, 147, .95);
  background: rgba(212, 88, 147, .18);
}
.pixel-world-behavior-dialog {
  position: absolute;
  width: min(400px, 44vw);
  min-width: 300px;
  box-sizing: border-box;
  transform: translate(-50%, -100%);
  border: 1px solid rgba(124, 168, 216, .72);
  border-radius: 8px;
  background: rgba(255, 255, 255, .97);
  color: #263e58;
  padding: 11px;
  z-index: 999999;
  box-shadow: 0 14px 30px rgba(42, 63, 88, .2);
  pointer-events: auto;
  user-select: none;
}
.pixel-world-behavior-dialog::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -7px;
  width: 12px;
  height: 12px;
  transform: translateX(-50%) rotate(45deg);
  border-right: 1px solid rgba(124, 168, 216, .72);
  border-bottom: 1px solid rgba(124, 168, 216, .72);
  background: rgba(255, 255, 255, .97);
}
.pixel-world-behavior-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.pixel-world-behavior-dialog-head strong {
  min-width: 0;
  color: #203954;
  font-size: 12px;
  font-weight: 950;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-behavior-dialog-head span {
  flex: 0 0 auto;
  border: 1px solid #d7e7f5;
  border-radius: 999px;
  background: #f3f8ff;
  color: #4f7395;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 900;
}
.pixel-world-behavior-dialog p {
  margin: 0 0 10px;
  color: #314d68;
  font-size: 13px;
  font-weight: 850;
  line-height: 1.5;
  white-space: normal;
  word-break: break-word;
}
.pixel-world-behavior-dialog button {
  min-width: 0;
  min-height: 30px;
  box-sizing: border-box;
  border: 1px solid #cddff2;
  border-radius: 7px;
  background: #f7fbff;
  color: #2c5f8d;
  font: inherit;
  font-size: 11px;
  font-weight: 950;
  cursor: pointer;
}
.pixel-world-behavior-dialog button:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.pixel-world-behavior-dialog-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.pixel-world-interaction-entry {
  position: absolute;
  min-width: 86px;
  min-height: 36px;
  box-sizing: border-box;
  border: 1px solid rgba(142, 190, 232, .82);
  border-radius: 8px;
  background: rgba(255, 255, 255, .96);
  color: #2d5f8d;
  padding: 5px 9px;
  z-index: 999998;
  box-shadow: 0 9px 20px rgba(50, 74, 98, .18);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  transition: transform 120ms ease;
}
.pixel-world-interaction-entry.side-left {
  transform: translate(calc(-100% - 10px), -50%);
}
.pixel-world-interaction-entry.side-right {
  transform: translate(10px, -50%);
}
.pixel-world-interaction-entry strong,
.pixel-world-interaction-entry span {
  display: block;
  line-height: 1.15;
}
.pixel-world-interaction-entry strong {
  font-size: 12px;
  font-weight: 950;
}
.pixel-world-interaction-entry span {
  max-width: 100px;
  margin-top: 2px;
  color: #5c7892;
  font-size: 10px;
  font-weight: 850;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-interaction-entry:hover {
  box-shadow: 0 12px 24px rgba(50, 74, 98, .22);
}
.pixel-world-interaction-entry:disabled {
  opacity: .58;
  cursor: not-allowed;
}
.pixel-world-interaction-menu {
  position: absolute;
  width: 270px;
  max-height: min(360px, 72%);
  box-sizing: border-box;
  border: 1px solid rgba(160, 196, 226, .78);
  border-radius: 8px;
  background: rgba(255, 255, 255, .96);
  color: #314d68;
  padding: 9px;
  z-index: 999999;
  box-shadow: 0 14px 30px rgba(54, 73, 94, .2);
  overflow: auto;
  pointer-events: auto;
  user-select: none;
}
.pixel-world-interaction-menu.side-left {
  transform: translate(calc(-100% - 12px), 0);
}
.pixel-world-interaction-menu.side-right {
  transform: translate(12px, 0);
}
.pixel-world-interaction-menu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}
.pixel-world-interaction-menu-head strong {
  min-width: 0;
  color: #233d57;
  font-size: 12px;
  font-weight: 950;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-interaction-menu-head span {
  flex: 0 0 auto;
  border: 1px solid #cde7d8;
  border-radius: 999px;
  background: #eefaf3;
  color: #3f775f;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 900;
}
.pixel-world-interaction-close {
  flex: 0 0 auto;
  min-height: 25px !important;
  padding: 3px 8px !important;
  border-color: #d7e7f5 !important;
  background: #f6fbff !important;
  color: #4f7395 !important;
  font-size: 10px !important;
}
.pixel-world-interaction-menu-primary,
.pixel-world-interaction-menu-context {
  display: grid;
  gap: 6px;
}
.pixel-world-interaction-menu-primary {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.pixel-world-interaction-menu-context {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.pixel-world-interaction-menu button,
.pixel-world-interaction-menu select {
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid #d7e7f5;
  border-radius: 7px;
  background: #fff;
  color: #3d5e79;
  font: inherit;
  font-size: 11px;
  font-weight: 900;
}
.pixel-world-interaction-menu button {
  min-height: 30px;
  padding: 5px 7px;
  cursor: pointer;
}
.pixel-world-interaction-menu button.active {
  border-color: #72a7d8;
  background: #e9f4ff;
  color: #245b8e;
}
.pixel-world-interaction-menu button:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.pixel-world-interaction-menu-target {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  margin: 7px 0;
  color: #607383;
  font-size: 11px;
  font-weight: 900;
}
.pixel-world-interaction-menu select {
  width: 100%;
  min-height: 30px;
  padding: 4px 7px;
}
.pixel-world-player-help {
  border: 1px solid #d7efe3;
  background: #f1fff8;
  color: #4c8a6c;
  border-radius: 7px;
  padding: 7px 9px;
  font-weight: 800;
}
.pixel-world-player-switch-control,
.pixel-world-auto-walk-control,
.pixel-world-player-scale-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border: 1px solid #efd1df;
  border-radius: 7px;
  background: #fffafd;
  color: #75546e;
  font-size: 12px;
  font-weight: 800;
}
.pixel-world-player-switch-control select,
.pixel-world-auto-walk-control select {
  max-width: 142px;
  border: 1px solid #ead0dc;
  border-radius: 5px;
  background: #fff;
  color: #60475c;
  padding: 4px 6px;
  font: inherit;
}
.pixel-world-player-switch-control strong {
  color: #d45893;
}
.pixel-world-auto-walk-control button {
  padding: 4px 8px;
  border-radius: 5px;
}
.pixel-world-player-scale-control input[type="range"] {
  width: 110px;
  accent-color: #d45893;
}
.pixel-world-player-scale-control input[type="number"] {
  width: 58px;
  border: 1px solid #ead0dc;
  border-radius: 5px;
  background: #fff;
  color: #60475c;
  padding: 4px 5px;
  font: inherit;
}
.pixel-world-player-scale-control strong {
  min-width: 42px;
  color: #d45893;
  text-align: right;
}
.pixel-world-selected-name {
  margin-bottom: 10px;
  padding: 9px;
  border: 1px solid #f3d2e2;
  border-radius: 7px;
  background: #fffafd;
  color: #6d4c65;
  font-size: 13px;
  font-weight: 800;
}
.pixel-world-layer-mode-card {
  display: grid;
  gap: 5px;
  margin-bottom: 10px;
  padding: 9px;
  border: 1px solid #ead0dc;
  border-radius: 7px;
  background: #fff;
}
.pixel-world-layer-mode-card.ground {
  border-color: #cde5d7;
  background: #f7fff9;
}
.pixel-world-layer-mode-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pixel-world-layer-mode-head strong {
  color: #60475c;
  font-size: 12px;
}
.pixel-world-layer-mode-card small {
  color: #8a7488;
  font-size: 11px;
  line-height: 1.4;
}
.pixel-world-place-card {
  display: grid;
  gap: 4px;
  margin-bottom: 10px;
  padding: 9px;
  border: 1px solid #ecd6f4;
  border-radius: 7px;
  background: #fffbff;
}
.pixel-world-place-card strong {
  color: #8a4f9f;
  font-size: 12px;
}
.pixel-world-place-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pixel-world-place-card-head button {
  width: auto;
  min-height: 28px;
  padding: 5px 9px;
  border: 1px solid #ecd6f4;
  border-radius: 7px;
  background: #fffafd;
  color: #7f6077;
  font-size: 11px;
  font-weight: 900;
}
.pixel-world-place-card span {
  color: #60475c;
  font-size: 13px;
  font-weight: 800;
}
.pixel-world-place-card small {
  color: #8a7488;
  font-size: 11px;
  line-height: 1.35;
}
.pixel-world-place-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 4px;
}
.pixel-world-inspector .pixel-world-place-fields label {
  grid-template-columns: 20px minmax(0, 1fr);
  margin: 0;
}
.pixel-world-inspector label {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: #8a7488;
  font-size: 12px;
  font-weight: 800;
}
.pixel-world-inspector input,
.pixel-world-inspector textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ead0dc;
  border-radius: 6px;
  background: #fffafd;
  color: #60475c;
  padding: 7px 8px;
  font: inherit;
}
.pixel-world-inspector textarea {
  min-height: 180px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.pixel-world-nudge-pad {
  display: grid;
  grid-template-columns: repeat(3, 34px);
  grid-template-areas:
    ". up ."
    "left . right"
    ". down .";
  justify-content: center;
  gap: 6px;
  margin: 12px 0;
}
.pixel-world-nudge-pad button,
.pixel-world-scale-row button {
  border: 1px solid #efd1df;
  background: #fffafd;
  color: #75546e;
  border-radius: 7px;
  cursor: pointer;
  font-weight: 900;
}
.pixel-world-nudge-pad button {
  width: 34px;
  height: 30px;
}
.pixel-world-nudge-pad button:nth-child(1) {
  grid-area: up;
}
.pixel-world-nudge-pad button:nth-child(2) {
  grid-area: left;
}
.pixel-world-nudge-pad button:nth-child(3) {
  grid-area: right;
}
.pixel-world-nudge-pad button:nth-child(4) {
  grid-area: down;
}
.pixel-world-scale-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.pixel-world-scale-row button {
  padding: 8px 10px;
  font-size: 12px;
}
.pixel-world-collision-editor {
  display: grid;
  gap: 8px;
  margin: 10px 0;
  padding: 10px;
  border: 1px solid #d8eadf;
  border-radius: 8px;
  background: #fbfffc;
}
.pixel-world-collision-editor.active {
  border-color: #74c99a;
  box-shadow: 0 0 0 2px rgba(51, 181, 118, .12);
}
.pixel-world-collision-editor-head,
.pixel-world-collision-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pixel-world-collision-editor-head strong {
  color: #48765e;
  font-size: 12px;
}
.pixel-world-collision-editor-head button {
  border: 1px solid #cde5d7;
  background: #f6fff9;
  color: #48765e;
  border-radius: 7px;
  cursor: pointer;
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-collision-toggle {
  display: inline-flex;
  grid-template-columns: none;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: #48765e;
}
.pixel-world-collision-toggle input {
  width: auto;
  accent-color: #33b576;
}
.pixel-world-collision-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.pixel-world-collision-fields label {
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 6px;
  margin: 0;
}
.pixel-world-collision-fields input {
  padding: 6px;
}
.pixel-world-collision-actions button {
  flex: 1;
  border: 1px solid #cde5d7;
  background: #f6fff9;
  color: #48765e;
  border-radius: 7px;
  cursor: pointer;
  padding: 7px 9px;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-layer-panel {
  display: grid;
  gap: 8px;
  margin: 12px 0;
  padding: 10px;
  border: 1px solid #ead0dc;
  border-radius: 8px;
  background: #fffbff;
}
.pixel-world-layer-panel-head {
  display: grid;
  gap: 3px;
}
.pixel-world-layer-panel-head strong {
  color: #60475c;
  font-size: 13px;
}
.pixel-world-layer-panel-head small {
  color: #967d91;
  font-size: 11px;
  line-height: 1.35;
}
.pixel-world-layer-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid #efd1df;
  border-radius: 7px;
  background: #fffafd;
  color: #60475c;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-layer-current span {
  color: #d45893;
}
.pixel-world-layer-list {
  display: grid;
  gap: 6px;
  max-height: 260px;
  overflow: auto;
  padding-right: 2px;
}
.pixel-world-layer-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px;
  border: 1px solid #efd1df;
  border-radius: 7px;
  background: #fff;
  color: #60475c;
  cursor: pointer;
  text-align: left;
}
.pixel-world-layer-row.active {
  border-color: #35a6ff;
  box-shadow: 0 0 0 2px rgba(53, 166, 255, .14);
}
.pixel-world-layer-row.ground {
  border-color: #d8eadf;
  background: #fbfffc;
}
.pixel-world-layer-index {
  color: #d45893;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-layer-name {
  min-width: 0;
  color: #60475c;
  font-size: 12px;
  font-weight: 900;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-layer-name small {
  display: block;
  margin-top: 2px;
  color: #967d91;
  font-size: 10px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-layer-kind {
  justify-self: end;
  padding: 3px 5px;
  border-radius: 999px;
  background: #fff0f8;
  color: #9c4f78;
  font-size: 10px;
  font-weight: 900;
}
.pixel-world-layer-row.ground .pixel-world-layer-kind {
  background: #ecfff4;
  color: #48765e;
}
.pixel-world-inspector p,
.pixel-world-inspector-hint {
  color: #8a7488;
  font-size: 12px;
  line-height: 1.5;
}
.pixel-world-behavior-panel {
  display: grid;
  gap: 12px;
  align-content: start;
  background:
    linear-gradient(180deg, #fbfdff 0%, #ffffff 54%, #fbfff9 100%);
  border-color: #d7e7f5;
  color: #4d5d68;
}
.pixel-world-behavior-panel.collapsed {
  padding: 8px;
  overflow: hidden;
}
.pixel-world-behavior-panel-expand {
  width: 100%;
  min-height: 180px;
  display: grid;
  place-items: center;
  gap: 8px;
  border: 1px solid #d7e7f5;
  border-radius: 8px;
  background: #f8fbfe;
  color: #314d68;
  cursor: pointer;
  font: inherit;
}
.pixel-world-behavior-panel-expand span {
  writing-mode: vertical-rl;
  color: #314d68;
  font-size: 13px;
  font-weight: 950;
  letter-spacing: 0;
}
.pixel-world-behavior-panel-expand strong {
  padding: 4px 5px;
  border-radius: 6px;
  background: #e9f4ff;
  color: #356fa6;
  font-size: 9.5px;
  font-weight: 950;
}
.pixel-world-behavior-panel-expand small {
  color: #7a94aa;
  font-size: 10px;
  font-weight: 900;
}
.pixel-world-behavior-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.pixel-world-behavior-head h3 {
  margin: 0 0 3px;
  color: #314d68;
}
.pixel-world-behavior-head span {
  color: #738698;
  font-size: 12px;
}
.pixel-world-behavior-head strong {
  padding: 5px 7px;
  border-radius: 6px;
  background: #e9f4ff;
  color: #356fa6;
  font-size: 11px;
  font-weight: 900;
}
.pixel-world-behavior-head-actions {
  display: grid;
  justify-items: end;
  gap: 6px;
}
.pixel-world-behavior-head-actions button {
  min-height: 26px;
  border: 1px solid #d7e7f5;
  border-radius: 7px;
  background: #fff;
  color: #356fa6;
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
  padding: 4px 8px;
}
.pixel-world-behavior-actors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.pixel-world-behavior-actor {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 76px;
  padding: 8px;
  border: 1px solid #d9e8f6;
  border-radius: 8px;
  background: #f7fbff;
}
.pixel-world-behavior-actor.user {
  border-color: #d8eadf;
  background: #f7fff9;
}
.pixel-world-behavior-actor img {
  width: 36px;
  height: 48px;
  object-fit: contain;
  image-rendering: pixelated;
}
.pixel-world-behavior-actor div {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.pixel-world-behavior-actor strong {
  color: #314d68;
  font-size: 12px;
}
.pixel-world-behavior-actor.user strong {
  color: #3a7d61;
}
.pixel-world-behavior-actor span,
.pixel-world-behavior-actor small {
  overflow: hidden;
  color: #738698;
  font-size: 10px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-behavior-field {
  display: grid;
  gap: 5px;
  margin: 0;
  color: #607383;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-behavior-field > span {
  color: #607383;
}
.pixel-world-behavior-field input,
.pixel-world-behavior-field select,
.pixel-world-behavior-field textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #d7e7f5;
  border-radius: 7px;
  background: #fff;
  color: #314d68;
  padding: 8px 9px;
  font: inherit;
}
.pixel-world-behavior-field textarea {
  min-height: 72px;
  resize: vertical;
  line-height: 1.45;
}
.pixel-world-behavior-model-grid {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid #e1ecf6;
  border-radius: 8px;
  background: #f8fbfe;
}
.pixel-world-behavior-model-actions,
.pixel-world-behavior-run-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.pixel-world-behavior-model-actions button,
.pixel-world-behavior-run-row button,
.pixel-world-behavior-actions button {
  min-height: 34px;
  border: 1px solid #d7e7f5;
  border-radius: 7px;
  background: #fff;
  color: #356fa6;
  cursor: pointer;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-behavior-model-actions button:disabled,
.pixel-world-behavior-run-row button:disabled {
  opacity: .5;
  cursor: not-allowed;
}
.pixel-world-behavior-run-row button.primary {
  border-color: #b9ddca;
  background: #edf9f2;
  color: #3a7d61;
}
.pixel-world-behavior-model-status {
  min-height: 28px;
  padding: 7px 8px;
  border: 1px solid #dcebf6;
  border-radius: 7px;
  background: #fff;
  color: #607383;
  font-size: 11px;
  font-weight: 850;
  line-height: 1.35;
}
.pixel-world-behavior-model-status.error {
  border-color: #f0c5d3;
  background: #fff8fb;
  color: #9c4f68;
}
.pixel-world-behavior-model-list {
  display: grid;
  gap: 7px;
  padding: 8px;
  border: 1px solid #dcebf6;
  border-radius: 8px;
  background: #fff;
}
.pixel-world-behavior-model-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #607383;
  font-size: 11px;
  font-weight: 900;
}
.pixel-world-behavior-model-list-head span {
  color: #7a94aa;
}
.pixel-world-behavior-model-options {
  display: grid;
  gap: 5px;
  max-height: 180px;
  overflow: auto;
  padding-right: 2px;
}
.pixel-world-behavior-model-options button {
  width: 100%;
  min-height: 28px;
  border: 1px solid #e0ebf5;
  border-radius: 7px;
  background: #fbfdff;
  color: #3d5e79;
  padding: 5px 7px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 850;
  line-height: 1.25;
  text-align: left;
  overflow-wrap: anywhere;
}
.pixel-world-behavior-model-options button.active {
  border-color: #72a7d8;
  background: #e9f4ff;
  color: #245b8e;
  box-shadow: 0 0 0 2px rgba(114, 167, 216, .12);
}
.pixel-world-behavior-fold {
  min-width: 0;
  border: 1px solid #e1ecf6;
  border-radius: 8px;
  background: #fbfdff;
  overflow: hidden;
}
.pixel-world-behavior-fold-head {
  width: 100%;
  min-height: 38px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  color: #314d68;
  padding: 8px 9px;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.pixel-world-behavior-fold.open .pixel-world-behavior-fold-head {
  border-bottom: 1px solid #e1ecf6;
  background: #f8fbfe;
}
.pixel-world-behavior-fold-head span {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 950;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-behavior-fold-head small {
  max-width: 150px;
  overflow: hidden;
  color: #7a94aa;
  font-size: 10.5px;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-behavior-fold-head strong {
  min-width: 38px;
  border: 1px solid #d7e7f5;
  border-radius: 999px;
  background: #fff;
  color: #356fa6;
  padding: 3px 7px;
  font-size: 10.5px;
  font-weight: 950;
  text-align: center;
}
.pixel-world-behavior-fold-body {
  display: grid;
  gap: 9px;
  padding: 9px;
}
.pixel-world-behavior-fold-body > .pixel-world-behavior-model-grid,
.pixel-world-behavior-fold-body > .pixel-world-behavior-constraints,
.pixel-world-behavior-fold-body > .pixel-world-behavior-branch-map {
  border: 0;
  background: transparent;
  padding: 0;
}
.pixel-world-behavior-section-title {
  color: #314d68;
  font-size: 12px;
  font-weight: 900;
}
.pixel-world-behavior-constraints {
  display: grid;
  gap: 8px;
  padding: 9px;
  border: 1px solid #e1ecf6;
  border-radius: 8px;
  background: #fbfdff;
}
.pixel-world-behavior-constraints strong {
  display: block;
  margin-bottom: 6px;
  color: #607383;
  font-size: 11px;
}
.pixel-world-behavior-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.pixel-world-behavior-chip-list span {
  min-height: 23px;
  display: inline-flex;
  align-items: center;
  border: 1px solid #dbe8f4;
  border-radius: 7px;
  background: #fff;
  color: #3d5e79;
  padding: 3px 7px;
  font-size: 11px;
  font-weight: 850;
}
.pixel-world-behavior-branch-map {
  display: grid;
  gap: 7px;
  padding: 9px;
  border: 1px solid #e7e1f3;
  border-radius: 8px;
  background: #fdfbff;
}
.pixel-world-behavior-branch-map div {
  display: grid;
  gap: 3px;
}
.pixel-world-behavior-branch-map strong {
  color: #604f82;
  font-size: 11px;
  font-weight: 950;
}
.pixel-world-behavior-branch-map span {
  color: #7c6f93;
  font-size: 11px;
  line-height: 1.35;
}
.pixel-world-behavior-proximity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 9px;
  border: 1px solid #eadde6;
  border-radius: 8px;
  background: #fffafd;
  color: #75546e;
  font-size: 11px;
  font-weight: 900;
}
.pixel-world-behavior-proximity strong,
.pixel-world-behavior-proximity span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pixel-world-behavior-proximity.nearby {
  border-color: #cde7d8;
  background: #f1fff8;
  color: #3f775f;
}
.pixel-world-behavior-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.pixel-world-behavior-actions button {
  color: #607383;
}
.pixel-world-behavior-actions button.active {
  border-color: #72a7d8;
  background: #e9f4ff;
  color: #245b8e;
  box-shadow: 0 0 0 2px rgba(114, 167, 216, .14);
}
.pixel-world-behavior-status {
  min-height: 34px;
  padding: 8px 9px;
  border: 1px solid #e2edf5;
  border-radius: 7px;
  background: #fbfdff;
  color: #607383;
  font-size: 12px;
  line-height: 1.35;
}
.pixel-world-behavior-runtime {
  display: grid;
  gap: 3px;
  padding: 8px 9px;
  border: 1px solid #eadde6;
  border-radius: 8px;
  background: #fffafd;
  color: #75546e;
}
.pixel-world-behavior-runtime.active {
  border-color: #cde7d8;
  background: #f1fff8;
  color: #3f775f;
}
.pixel-world-behavior-runtime strong {
  color: inherit;
  font-size: 11px;
  font-weight: 950;
}
.pixel-world-behavior-runtime span {
  color: #314d68;
  font-size: 12px;
  font-weight: 900;
  line-height: 1.25;
}
.pixel-world-behavior-runtime small {
  color: #7a94aa;
  font-size: 10.5px;
  font-weight: 800;
}
.pixel-world-behavior-runtime-control {
  display: grid;
  gap: 7px;
  margin-top: 5px;
  padding: 8px;
  border: 1px solid #cde7d8;
  border-radius: 8px;
  background: rgba(255, 255, 255, .74);
}
.pixel-world-behavior-runtime-control strong {
  color: #3f775f;
  font-size: 11px;
}
.pixel-world-behavior-runtime-control p {
  margin: 0;
  color: #314d68;
  font-size: 12px;
  font-weight: 850;
  line-height: 1.4;
  word-break: break-word;
}
.pixel-world-behavior-runtime-control button {
  min-height: 30px;
  border: 1px solid #cddff2;
  border-radius: 7px;
  background: #f7fbff;
  color: #2c5f8d;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 950;
}
.pixel-world-behavior-runtime-control button:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.pixel-world-behavior-runtime-choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.pixel-world-behavior-json-grid {
  display: grid;
  gap: 9px;
}
.pixel-world-behavior-json-grid section {
  min-width: 0;
  border: 1px solid #e1ecf6;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}
.pixel-world-behavior-json-grid h4 {
  margin: 0;
  padding: 7px 9px;
  border-bottom: 1px solid #e1ecf6;
  background: #f8fbfe;
  color: #314d68;
  font-size: 12px;
}
.pixel-world-behavior-json-grid pre {
  max-height: 230px;
  margin: 0;
  padding: 9px;
  overflow: auto;
  color: #314d68;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 1500px) {
  .pixel-world-editor-body {
    grid-template-columns: 220px minmax(420px, 1fr) 300px;
  }
  .pixel-world-editor-body.behavior-collapsed {
    grid-template-columns: 200px minmax(560px, 1fr) 230px 54px;
  }
  .pixel-world-behavior-panel {
    grid-column: 1 / -1;
  }
  .pixel-world-editor-body.behavior-collapsed .pixel-world-behavior-panel {
    grid-column: auto;
  }
  .pixel-world-behavior-json-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 980px) {
  .pixel-world-header {
    align-items: stretch;
    flex-direction: column;
  }
  .pixel-world-tabs {
    width: fit-content;
  }
  .pixel-world-main {
    grid-template-columns: 1fr;
  }
  .pixel-world-editor-body {
    grid-template-columns: 1fr;
  }
  .pixel-world-editor-body.behavior-collapsed {
    grid-template-columns: 1fr;
  }
  .pixel-world-behavior-panel {
    grid-column: auto;
  }
  .pixel-world-behavior-panel.collapsed {
    min-height: 54px;
  }
  .pixel-world-behavior-panel-expand {
    min-height: 38px;
    grid-template-columns: 1fr auto auto;
  }
  .pixel-world-behavior-panel-expand span {
    writing-mode: horizontal-tb;
  }
  .pixel-world-behavior-json-grid,
  .pixel-world-behavior-actors {
    grid-template-columns: 1fr;
  }
  .pixel-world-editor-stage {
    min-width: 0;
  }
  .pixel-world-stage {
    --tile: clamp(20px, 5vw, 30px);
  }
}
`;
