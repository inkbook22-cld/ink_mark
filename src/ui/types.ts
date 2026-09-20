export type Field<T = string> = {
  value: T;
  source: 'ai' | 'user';
  locked: boolean;
  editedAt: string | null;
  version: number;
};

export type Card = {
  id: string;
  design: Field;
  eyebrow: Field;
  headline: Field;
  body: Field;
  photoPrompt: Field;
  photo: Field<string | null>;
};

export type Bundle = {
  schemaVersion: number;
  missingInfo: string[];
  blog: {
    title: Field;
    bodyMarkdown: Field;
    images: { id: string; afterSection: number; prompt: Field; alt: Field; path: Field<string | null> }[];
  };
  instagram: { cards: Card[]; caption: Field; hashtags: Field<string[]> };
};

export type Issue = { level: 'error' | 'warn' | 'info'; where: string; message: string };

export type GenerateResult = {
  projectId: string;
  projectDir: string;
  bundle: Bundle;
  cards: { cardId: string; design: string; path: string; relPath: string }[];
  issues: Issue[];
  failures: { where: string; message: string; kind: string }[];
  costUsd: number;
  estimate: { totalUsd: number; imageCount: number };
  exported: { outDir: string; written: string[] } | null;
  mocked?: boolean;
  mergeReport?: { kept: string[]; replaced: string[]; overwritten: string[] };
  error?: string;
};

export type Brand = {
  id?: string;
  name: string;
  audience?: string;
  contact?: string;
  colors?: { primary?: string; accent?: string; ink?: string; paper?: string };
  toneExamples?: string[];
  bannedWords?: string[];
  channels?: { naverBlogId?: string; instagram?: string };
};

export type KeyStatus = {
  available: boolean;
  openai: { set: boolean; hint: string | null };
  gemini: { set: boolean; hint: string | null };
};

declare global {
  interface Window {
    ink: {
      listBrands(): Promise<Brand[]>;
      saveBrand(brand: Brand): Promise<{ id: string }>;
      keyStatus(): Promise<KeyStatus>;
      setKey(provider: string, value: string | null): Promise<KeyStatus>;
      estimate(o: { cardCount: number; providedPhotos?: number }): Promise<{ totalUsd: number; imageCount: number; note: string }>;
      generate(o: { brandId: string; source: string; cardCount: number; budgetUsd?: number; imageProvider?: string }): Promise<GenerateResult>;
      regenerate(o: { projectId: string; mode: 'photo' | 'text' | 'all'; source?: string; imageProvider?: string }): Promise<GenerateResult>;
      describeLocks(projectId: string, mode: string): Promise<{ message: string }>;
      editField(projectId: string, path: string, value: unknown): Promise<{ bundle: Bundle }>;
      getBundle(projectId: string, version?: number): Promise<{ bundle: Bundle; versions: { version: number; label: string }[] }>;
      revert(projectId: string, version: number): Promise<{ bundle: Bundle }>;
      validate(projectId: string): Promise<{ issues: Issue[]; counts: Record<string, number> }>;
      naverDraft(o: { projectId: string; blogId: string; typeMode?: 'key' | 'ime' }): Promise<{ status: string; issues: string[] }>;
      openFolder(path: string): Promise<string>;
      onProgress(cb: (p: { jobId: string | null; text: string }) => void): () => void;
    };
  }
}
