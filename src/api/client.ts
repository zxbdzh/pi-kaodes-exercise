import {
  ChapterPracticeNode,
  ExerciseItem,
  SubmitPracticeResult,
} from '../types.js';
import { AuthManager } from '../auth/manager.js';

export interface ApiResponse<T> {
  code: number;
  message: string;
  flag: boolean;
  data: T;
}

export interface ProductItem {
  productId: number;
  courseId?: string | null;
  name: string;
  specialName: string;
  validDay: number;
  maxEndTime: string;
  productLearn: number;
  expiredStatus: boolean;
}

export interface CourseListItem {
  courseID: string;
  courseName: string;
  cstid: number;
  [key: string]: unknown;
}

export interface CourseDetailResponse {
  courseId: string;
  courseName: string;
  cstId: number;
  courseInformationList: Array<{
    name: string;
    num: number;
    type: number;
    expiredStatus: boolean;
  }>;
}

/**
 * Kaodes 官方 API Client
 * 基地址: https://beegoapi.beeeeego.com/mobile/
 */
export class KaodesClient {
  private baseUrl: string;
  private authManager: AuthManager;

  constructor(authManager: AuthManager, baseUrl = 'https://beegoapi.beeeeego.com/mobile/') {
    this.authManager = authManager;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string | number | boolean | undefined>;
      body?: Record<string, unknown> | string;
      isJson?: boolean;
    } = {}
  ): Promise<ApiResponse<T>> {
    const token = await this.authManager.ensureValidToken();
    let url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint.slice(1) : endpoint}`;

    if (options.params) {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined) query.append(k, String(v));
      }
      const qs = query.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      platform: 'Pc',
      token: token,
    };

    let reqBody: string | undefined;
    if (options.method === 'POST') {
      if (options.isJson) {
        headers['Content-Type'] = 'application/json';
        reqBody = typeof options.body === 'string' ? options.body : JSON.stringify(options.body || {});
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        if (typeof options.body === 'string') {
          reqBody = options.body;
        } else if (options.body) {
          const form = new URLSearchParams();
          for (const [k, v] of Object.entries(options.body)) {
            if (v !== undefined && v !== null) {
              if (typeof v === 'object') {
                form.append(k, JSON.stringify(v));
              } else {
                form.append(k, String(v));
              }
            }
          }
          reqBody = form.toString();
        }
      }
    }

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: reqBody,
    });

    if (res.status === 401) {
      // Token 过期失效
      console.warn('\n[Kaodes] 401 未授权，请更新 Token。');
      const newToken = await this.authManager.promptForToken();
      headers.token = newToken;
      const retryRes = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: reqBody,
      });
      return this.parseResponse<T>(retryRes, endpoint);
    }

    return this.parseResponse<T>(res, endpoint);
  }

  private async parseResponse<T>(res: Response, endpoint: string): Promise<ApiResponse<T>> {
    const payload = (await res.json()) as ApiResponse<T>;
    if (!res.ok) {
      throw new Error(`${endpoint}: HTTP ${res.status}${payload?.message ? `，${payload.message}` : ''}`);
    }
    if (payload?.flag === false || (typeof payload?.code === 'number' && payload.code !== 200)) {
      throw new Error(`${endpoint}: ${payload.message || '接口调用失败'}（code ${payload.code}）`);
    }
    return payload;
  }

  /**
   * 获取用户产品（科目）列表
   */
  public async getUserProductList(pageNum = 1, pageSize = 20): Promise<ProductItem[]> {
    const res = await this.request<{ list: ProductItem[] }>('product/getUserProductList', {
      method: 'GET',
      params: { pageNum, pageSize, courseName: '' },
    });
    return res.data?.list || [];
  }

  /**
   * 获取产品对应的课程列表。官网对此接口使用 JSON POST。
   */
  public async getCourseList(productId: number): Promise<CourseListItem[]> {
    const res = await this.request<{ rows?: CourseListItem[] }>('course/list', {
      method: 'POST',
      isJson: true,
      body: { pageNum: 0, pageSize: 0, productId },
    });
    return res.data?.rows || [];
  }

  /**
   * 获取科目详情（包含可用练习模块）
   */
  public async getCourseDetail(courseId: string, productId: number): Promise<CourseDetailResponse | null> {
    const res = await this.request<CourseDetailResponse>('course/courseDetail', {
      method: 'GET',
      params: { courseId, productId },
    });
    return res.data || null;
  }

  /**
   * 获取章节练习目录树及统计
   */
  public async getChapterTree(
    courseId: string,
    cstId: number,
    productId: number
  ): Promise<{
    exerNum: number;
    finishExerNum: number;
    correctNum: number;
    correctRate: string;
    practiceChapter: ChapterPracticeNode[];
  }> {
    const res = await this.request<{
      exerNum: number;
      finishExerNum: number;
      correctNum: number;
      correctRate: string;
      practiceChapter: ChapterPracticeNode[];
    }>('course/chapter', {
      method: 'POST',
      isJson: true,
      body: { courseId, cstId, productId },
    });
    return res.data;
  }

  /**
   * 获取指定章节的练习题目
   */
  public async getChapterPractice(params: {
    catId: string;
    courseId: string;
    cstId: number;
    isRedo?: number;
    lastPosition?: number;
    linkName?: string;
    name?: string;
    scoringMethod?: number;
  }): Promise<{
    prId: number;
    scoringMethod: number;
    exerList: ExerciseItem[];
  }> {
    const res = await this.request<{
      prId: number;
      scoringMethod: number;
      exerList: ExerciseItem[];
    }>('course/practice', {
      method: 'POST',
      isJson: true,
      body: params,
    });
    return res.data;
  }

  /**
   * 暂存做题进度
   */
  public async savePractice(params: {
    prId: number;
    lastPosition: number;
    scoringMethod: number;
    time: number;
    exercises: Array<{
      exerId: number;
      score: number;
      starCount?: number;
      userKey?: string | null;
      userKeyImg1?: string | null;
      userKeyImg2?: string | null;
      userKeyImg3?: string | null;
      sonExer?: unknown[];
    }>;
  }): Promise<ApiResponse<unknown>> {
    return this.request('course/savePractice', {
      method: 'POST',
      isJson: true,
      body: params,
    });
  }

  /**
   * 提交练习答题并返回结果统计
   */
  public async submitPractice(params: {
    prId: number;
    lastPosition: number;
    scoringMethod: number;
    time: number;
    exercises: Array<{
      exerId: number;
      score: number;
      starCount?: number;
      userKey?: string | null;
      userKeyImg1?: string | null;
      userKeyImg2?: string | null;
      userKeyImg3?: string | null;
      sonExer?: unknown[];
    }>;
  }): Promise<ApiResponse<SubmitPracticeResult>> {
    return this.request<SubmitPracticeResult>('course/submitPractice', {
      method: 'POST',
      isJson: true,
      body: params,
    });
  }

  /**
   * 获取模拟考试列表
   */
  public async getMockExamList(courseId: string, pageNum = 1, pageSize = 20): Promise<Array<{ id: number; name: string; examTime: number; totalScore: number }>> {
    const res = await this.request<{ list: Array<{ id: number; name: string; examTime: number; totalScore: number }> }>('mockExam/getMockExamList', {
      method: 'GET',
      params: { courseId, pageNum, pageSize },
    });
    return res.data?.list || [];
  }

  /**
   * 获取指定模拟考试试卷题目详情
   */
  public async getMockExamInfo(examId: number): Promise<{
    examId: number;
    name: string;
    duration: number;
    exerList: ExerciseItem[];
  }> {
    const res = await this.request<{
      examId: number;
      name: string;
      duration: number;
      exerList: ExerciseItem[];
    }>('mockExam/getMockExamInfo', {
      method: 'GET',
      params: { examId },
    });
    return res.data;
  }

  /**
   * 提交模拟考试试卷
   */
  public async submitMockExam(params: {
    examId: number;
    time: number;
    exercises: Array<{ exerId: number; userKey: string | null }>;
  }): Promise<ApiResponse<{ score: number; isPass: boolean }>> {
    return this.request('exam/submitExam', {
      method: 'POST',
      isJson: true,
      body: params,
    });
  }

  /**
   * 获取答题闯关题组列表与关卡状态
   */
  public async getChallengeGroupList(courseId: string): Promise<Array<{ groupId: number; name: string; isPassed: boolean; exerCount: number }>> {
    const res = await this.request<Array<{ groupId: number; name: string; isPassed: boolean; exerCount: number }>>('special/getExercisesGroupList', {
      method: 'GET',
      params: { courseId },
    });
    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * 获取指定闯关关卡题目
   */
  public async getChallengePractice(groupId: number): Promise<{
    groupId: number;
    name: string;
    exerList: ExerciseItem[];
  }> {
    const res = await this.request<{
      groupId: number;
      name: string;
      exerList: ExerciseItem[];
    }>('special/exercisesGroupPractice', {
      method: 'POST',
      body: { groupId },
    });
    return res.data;
  }

  /**
   * 提交答题闯关结果
   */
  public async submitChallengePractice(params: {
    groupId: number;
    time: number;
    exercises: Array<{ exerId: number; userKey: string | null; isCorrect: number }>;
  }): Promise<ApiResponse<{ isPassed: boolean; rewardScore: number }>> {
    return this.request('special/submitExercisesPractice', {
      method: 'POST',
      isJson: true,
      body: params,
    });
  }

  /**
   * 记录错题到错题本
   */
  public async addWrong(params: {
    exerID: number;
    prid: number;
    catID: string | number;
    courseId: string;
    cstId: number;
    source: number;
    result: number;
  }): Promise<ApiResponse<unknown>> {
    return this.request('errorsCollect/addWrong', {
      method: 'POST',
      body: params,
    });
  }

  /**
   * 查询错题本列表
   */
  public async getWrongQuestions(courseId: string, pageNum = 1, pageSize = 20): Promise<ExerciseItem[]> {
    const res = await this.request<{ rows: ExerciseItem[] } | ExerciseItem[]>('errorsCollect/findWrong', {
      method: 'GET',
      params: { courseId, pageNum, pageSize },
    });
    if (Array.isArray(res.data)) return res.data;
    if (res.data && 'rows' in res.data) return res.data.rows;
    return [];
  }

  /**
   * 获取每日一练题目列表
   */
  public async getEverydayExercises(courseId: string): Promise<ExerciseItem[]> {
    const res = await this.request<{ exercises: ExerciseItem[] } | ExerciseItem[]>('userExercises/getEverydayExercises', {
      method: 'GET',
      params: { courseId },
    });
    if (Array.isArray(res.data)) return res.data;
    if (res.data && 'exercises' in res.data) return res.data.exercises;
    return [];
  }
}
