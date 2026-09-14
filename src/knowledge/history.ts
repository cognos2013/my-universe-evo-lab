/** Knowledge guide only. These are not initialized historical simulation states. */
export const historyGuide=[
  {id:'origin',age:'约 138 亿年前',title:'热而稠密的开端',body:'宇宙从早期热而稠密的状态膨胀、冷却。这里展示科学背景，不模拟未知的初始奇点。',source:'NASA · 宇宙概览',url:'https://science.nasa.gov/universe/overview/'},
  {id:'atoms',age:'大爆炸后约 38 万年',title:'光开始穿越宇宙',body:'原子核捕获电子，中性原子形成，宇宙逐渐对光透明。今天的宇宙微波背景保存了这一时期的信息。',source:'NASA · 宇宙概览',url:'https://science.nasa.gov/universe/overview/'},
  {id:'stars',age:'最初数亿年',title:'恒星与星系出现',body:'引力使物质聚集，恒星和星系逐步形成。恒星演化丰富了宇宙的元素，为后来的行星与生命提供原料。',source:'NASA · 我们从何而来',url:'https://science.nasa.gov/astrophysics/science-questions/how-did-universe-originate-and-evolve-produce-galaxies-stars-and-planets-we-see-today/'},
  {id:'earth',age:'约 45.4 亿年前',title:'地球形成',body:'放射性定年为地球年龄提供约束。海洋、大气和地质过程构成了后来生命演化的环境；本实验星球是人工场景，不是古地球复原。',source:'USGS · 地球年龄',url:'https://pubs.usgs.gov/gip/geotime/age.html'},
  {id:'life',age:'早期地球 · 起源尚不确定',title:'从化学到生命',body:'生命如何起源仍是开放的科学问题。本版本通过人工播种开启数字生命，不把播种称为自然起源。',source:'NASA · 生命如何开始',url:'https://www.nasa.gov/general/how-did-life-begin-on-earth-we-asked-a-nasa-scientist-episode-42/'},
  {id:'evolution',age:'漫长的生命历史',title:'生命形成分支',body:'遗传变异、选择和其他演化过程塑造生命多样性。这里的可运行模型限于无性队列与有限性状，不预设必然出现人类。',source:'Darwin Online · 物种起源',url:'https://darwin-online.org.uk/converted/pdf/1860_Origin_F379.pdf'},
  {id:'human',age:'约 30 万年前',title:'智人的出现',body:'化石等证据帮助研究智人的起源与变化。智能个体与人类社会尚未纳入此版本的计算模型。',source:'Smithsonian · Homo sapiens',url:'https://humanorigins.si.edu/evidence/human-fossils/species/homo-sapiens'},
  {id:'society',age:'近约 1.2 万年',title:'生产食物，改变环境',body:'农业与社会变化增强了人类改造周围环境的能力。文明制度、技术和生态的反馈是后续阶段的研究方向。',source:'Smithsonian · 人类特征',url:'https://humanorigins.si.edu/human-characteristics'},
  {id:'future',age:'未来 · 条件性的可能',title:'未来有多条路径',body:'未来情景回答“如果这些条件成立会怎样”，并不是唯一预言。当前可对数字生态世界做分支实验，真实地球未来模式尚未实现。',source:'IPCC · 情景与不确定性',url:'https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-1/'},
] as const;
