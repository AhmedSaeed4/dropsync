'use client';

import { useState, useEffect } from 'react';
import { createCategoriesListener, createCategory, deleteCategory, getCategoryDropCount } from '@/lib/categories';
import { Category } from '@/types';

export function useCategories(workspaceId: string | null, userId?: string | null) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Don't subscribe if no user is logged in
    if (!userId) {
      setCategories([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = createCategoriesListener(workspaceId, (cats) => {
      setCategories(cats);
      setLoading(false);
    });

    return unsubscribe;
  }, [workspaceId, userId]);

  const addCategory = async (name: string, creatorUserId: string): Promise<Category | null> => {
    return createCategory(workspaceId, name, creatorUserId);
  };

  const removeCategory = async (categoryId: string, categoryName: string): Promise<{ success: boolean; error?: string }> => {
    // Check if category has drops
    const count = await getCategoryDropCount(categoryName, workspaceId);
    if (count > 0) {
      return { success: false, error: 'Category has drops. Cannot delete.' };
    }

    const success = await deleteCategory(categoryId);
    return { success };
  };

  return {
    categories,
    loading,
    addCategory,
    removeCategory,
  };
}