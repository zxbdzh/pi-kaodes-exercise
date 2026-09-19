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
