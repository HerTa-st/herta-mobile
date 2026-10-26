/**
 * 相册（原生）。
 *
 * 她翻相册分两步：先列目录（只有 id / 名字 / 时间），再决定要不要看某一张。
 * 这样她不会被几十张原图淹没，也不会一开口就把你的相册全读进上下文。
 *
 * 权限是运行时申请的；被拒时这边会得到 granted:false，她会照实告诉你。
 */
import { registerPlugin } from "@capacitor/core";

export interface PhotoMeta {
  id: number;
  name: string;
  takenAt: number;
}

interface HertaGalleryPlugin {
  ensurePermission(): Promise<{ granted: boolean }>;
  list(options: { limit?: number }): Promise<{ photos: PhotoMeta[] }>;
  read(options: { id: number }): Promise<{ data: string; mediaType: string; width: number; height: number }>;
}

const HertaGallery = registerPlugin<HertaGalleryPlugin>("HertaGallery");

export const gallerySupported = () => true;

export async function ensureGalleryPermission(): Promise<boolean> {
  const { granted } = await HertaGallery.ensurePermission();
  return granted;
}

export async function listPhotos(limit = 40): Promise<PhotoMeta[]> {
  const { photos } = await HertaGallery.list({ limit });
  return photos ?? [];
}

export async function readPhoto(id: number): Promise<{ data: string; mediaType: string }> {
  const { data, mediaType } = await HertaGallery.read({ id });
  return { data, mediaType };
}
