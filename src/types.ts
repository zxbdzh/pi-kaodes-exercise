export interface AuthTokenPayload {
  userId?: number;
  sub?: string;
  ugid?: number;
  exp?: number;
  iat?: number;
}

export interface KaodesUser {
  userId: number;
  userName?: string;
  adminId?: number;
  agencyId?: number;
}

export interface KaodesConfig {
  token: string;
  baseUrl?: string;
  agencyId?: number;
  adminId?: number;
  userId?: number;
  lastUpdated?: string;
}

export interface ExerciseItem {
  exerId: number;
  exerID?: number;
  title: string;
  keyType: string;
  newKeyType: number; // 1: 单选, 2: 多选, 3: 论述题/主观题, 4: 判断题, etc.
  a?: string | null;
  b?: string | null;
  c?: string | null;
  d?: string | null;
  e?: string | null;
  f?: string | null;
  rightKey?: string;
  rightKeyList?: string[];
  analyze?: string;
  diffCoeff?: number;
  userKey?: string | null;
  doResult?: number; // 0: 未做, 1: 正确, -1: 错误
  isMark?: number;   // 0: 未标记, 1: 已标记
  viewAnswer?: number;
  starCount?: number;
  source?: string;
  /**
   * LLM 抽取的高亮词（第二阶段）：AI 回答当前题时顺带产出，缓存进 session。
   * 渲染时映射为偏移区间并与规则高亮合并；离线/未调用时为空，自动回落规则高亮。
   */
  llmMarks?: Array<{ term: string; kind: 'key' | 'warn' | 'concl' }>;
}

export interface ChapterPracticeNode {
  id: string;
  parentId: string;
  weight: number;
  name: string;
  catId: string;
  finishRate: string;
  finishExerNum: number;
  exerNum: number;
  correctNum: number;
  correctRate: string;
  lastPosition: number;
  learnStatus?: number;
  linkName?: string;
  cstid?: number;
  scoringMethod?: number;
  children?: ChapterPracticeNode[];
}

export interface PracticeSession {
  prId: number;
  scoringMethod: number;
  courseId: string;
  courseName: string;
  productId: number;
  cstId: number;
  catId?: string;
  chapterName?: string;
  exercises: ExerciseItem[];
  currentIndex: number;
  runSecond: number;
  startTime: number;
}

export interface SubmitPracticeResult {
  correctRate: string;
  exerNum: number;
  correctNum: number;
  errorNum: number;
  createDate: string;
  statistics?: Array<{
    new_key_type: number;
    new_key_name: string;
    correctNum: number;
    errorNum: number;
    exerNum: number;
  }>;
}
