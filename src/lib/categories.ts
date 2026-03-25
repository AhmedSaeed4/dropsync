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

// Create a custom category
export async function createCategory(
  workspaceId: string,
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
  workspaceId: string | null
): Promise<number> {
  try {
    const q = query(
      collection(db, DROPS_COLLECTION),
      where('category', '==', categoryName),
      where('workspaceId', '==', workspaceId)
    );

    const snapshot = await getDocs(q);
    return snapshot.size;
  } catch (error) {
    console.error('Error checking category drop count:', error);
    return 0;
  }
}

// Listen to categories for a workspace (or personal if workspaceId is null)
export function createCategoriesListener(
  workspaceId: string | null,
  callback: (categories: Category[]) => void
): () => void {
  const q = query(
    collection(db, CATEGORIES_COLLECTION),
    where('workspaceId', '==', workspaceId)
  );

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