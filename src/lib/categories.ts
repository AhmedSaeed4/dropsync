import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  getDocs
} from 'firebase/firestore';
import { db } from './firebase';
import { Category } from '@/types';

const CATEGORIES_COLLECTION = 'categories';
const DROPS_COLLECTION = 'drops';

// Built-in categories (not stored in DB, just used in UI)
export const BUILT_IN_CATEGORIES = ['password', 'link'] as const;

// Drop names that collide with a built-in pill key or are EXACT duplicates, so the category
// picker never renders two pills sharing a React key. CASE-SENSITIVE and exact-only on purpose:
// the DB is mixed-case (createCategory lowercases, ensureCategoriesForTarget preserves casing),
// and lowercasing-for-grouping would merge a 'Work' pill into a 'work'-tagged drop's selection
// and break edit-mode selected-state. Only the literal React-key collision is removed.
export function dedupeCategoryNames(names: string[]): string[] {
  const builtIn = new Set<string>(BUILT_IN_CATEGORIES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    if (builtIn.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// Create a custom category
export async function createCategory(
  workspaceId: string | null,
  name: string,
  userId: string
): Promise<Category | null> {
  try {
    const docRef = await addDoc(collection(db, CATEGORIES_COLLECTION), {
      name: name.toLowerCase().trim(),
      workspaceId,
      createdBy: userId,
      createdAt: serverTimestamp(),
    });

    return {
      id: docRef.id,
      name: name.toLowerCase().trim(),
      workspaceId,
      createdBy: userId,
      createdAt: new Date(),
    };
  } catch (error) {
    console.error('Error creating category:', error);
    return null;
  }
}

// Delete a category (only if no drops use it)
export async function deleteCategory(categoryId: string): Promise<boolean> {
  try {
    await deleteDoc(doc(db, CATEGORIES_COLLECTION, categoryId));
    return true;
  } catch (error) {
    console.error('Error deleting category:', error);
    return false;
  }
}

// Check if a category has any drops
export async function getCategoryDropCount(
  categoryName: string,
  workspaceId: string | null,
  userId?: string | null
): Promise<number> {
  try {
    const baseConstraints = workspaceId
      ? [where('workspaceId', '==', workspaceId)]
      : [where('userId', '==', userId), where('workspaceId', '==', null)];

    // Query categories array (new format)
    const arrayQ = query(
      collection(db, DROPS_COLLECTION),
      ...baseConstraints,
      where('categories', 'array-contains', categoryName)
    );
    const arraySnapshot = await getDocs(arrayQ);
    const ids = new Set(arraySnapshot.docs.map(d => d.id));

    // Query legacy category field (old format)
    const legacyQ = query(
      collection(db, DROPS_COLLECTION),
      ...baseConstraints,
      where('category', '==', categoryName)
    );
    const legacySnapshot = await getDocs(legacyQ);
    legacySnapshot.docs.forEach(d => ids.add(d.id));

    return ids.size;
  } catch (error) {
    console.error('Error checking category drop count:', error);
    return 0;
  }
}

// Listen to categories for a workspace (or personal if workspaceId is null)
export function createCategoriesListener(
  workspaceId: string | null,
  callback: (categories: Category[]) => void,
  userId?: string | null
): () => void {
  let q;
  if (workspaceId) {
    q = query(
      collection(db, CATEGORIES_COLLECTION),
      where('workspaceId', '==', workspaceId)
    );
  } else {
    q = query(
      collection(db, CATEGORIES_COLLECTION),
      where('createdBy', '==', userId),
      where('workspaceId', '==', null)
    );
  }

  return onSnapshot(q, (snapshot) => {
    const categories: Category[] = [];
    snapshot.forEach((document) => {
      const data = document.data();
      categories.push({
        id: document.id,
        name: data.name,
        workspaceId: data.workspaceId,
        createdBy: data.createdBy,
        createdAt: data.createdAt?.toDate() || new Date(),
      });
    });

    // Sort by name
    categories.sort((a, b) => a.name.localeCompare(b.name));
    callback(categories);
  }, (error) => {
    console.error('Firestore categories listener error:', error);
    callback([]);
  });
}

// lowercased category name -> canonical name. The canonical is the STORED doc `name` for an
// existing custom category, the trimmed source name for a freshly created one, and the trimmed
// source name for a built-in (password, link — which never get a doc).
export type CategoryNameMap = Map<string, string>;

// Resolve a set of category names for a target space in ONE pass: query the target's existing
// categories once, then create only the missing custom ones, returning a name map covering all
// inputs. Built-in categories (password, link) are mapped but never persisted. This is the
// race-free replacement for the per-drop check-then-create loops that used to live inline in
// moveDrop/copyDrop: when a batch of drops is moved/copied concurrently, each drop reuses this
// pre-resolved map instead of querying (and all missing the same "already exists" check). The
// normalization reproduces the old inline blocks EXACTLY (trimmed name, original casing preserved
// for new docs, stored casing reused for existing docs).
export async function ensureCategoriesForTarget(
  targetWorkspaceId: string | null,
  currentUserId: string,
  names: string[]
): Promise<CategoryNameMap> {
  const map: CategoryNameMap = new Map();
  const BUILT_IN = new Set(['password', 'link']);
  const custom: string[] = [];
  for (const raw of names) {
    const lower = raw.toLowerCase().trim();
    if (!lower) continue;
    if (BUILT_IN.has(lower)) {
      map.set(lower, raw.trim());
    } else {
      custom.push(raw);
    }
  }

  if (custom.length > 0) {
    const q = targetWorkspaceId
      ? query(collection(db, CATEGORIES_COLLECTION), where('workspaceId', '==', targetWorkspaceId))
      : query(collection(db, CATEGORIES_COLLECTION), where('createdBy', '==', currentUserId), where('workspaceId', '==', null));
    const snap = await getDocs(q);
    snap.forEach(d => {
      const data = d.data();
      map.set((data.name as string).toLowerCase().trim(), data.name as string);
    });

    for (const raw of custom) {
      const lower = raw.toLowerCase().trim();
      if (!map.has(lower)) {
        const trimmed = raw.trim();
        await addDoc(collection(db, CATEGORIES_COLLECTION), {
          name: trimmed,
          workspaceId: targetWorkspaceId,
          createdBy: currentUserId,
          createdAt: serverTimestamp(),
        });
        map.set(lower, trimmed);
      }
    }
  }

  return map;
}