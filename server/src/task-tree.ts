import type { TaskMessageContent, TaskMessageItem } from './types.js';

export type FlattenedTaskItemContext = {
  sectionTitle: string;
  assignee: string;
  path: string[];
  item: TaskMessageItem;
};

function isTaskItemTreeCompleted(item: TaskMessageItem): boolean {
  const children = item.children ?? [];
  return item.completed && children.every((child) => isTaskItemTreeCompleted(child));
}

function cascadeTaskItemCompletion(item: TaskMessageItem, completed: boolean, completedByNickname: string | null): TaskMessageItem {
  const nextCompletedByNickname = completed
    ? (item.completed && item.completedByNickname ? item.completedByNickname : completedByNickname)
    : null;
  const nextChildren = item.children?.map((child) => cascadeTaskItemCompletion(child, completed, completedByNickname));

  return {
    ...item,
    completed,
    completedByNickname: nextCompletedByNickname,
    ...(nextChildren ? { children: nextChildren } : {}),
  };
}

function syncParentTaskItemCompletion(item: TaskMessageItem): TaskMessageItem {
  const children = item.children;
  if (!children || children.length === 0) {
    return item;
  }

  const childrenCompleted = children.every((child) => isTaskItemTreeCompleted(child));
  if (childrenCompleted) {
    if (item.completed) {
      return item;
    }

    return {
      ...item,
      completed: true,
      completedByNickname: null,
    };
  }

  if (!item.completed && item.completedByNickname === null) {
    return item;
  }

  return {
    ...item,
    completed: false,
    completedByNickname: null,
  };
}

function updateTaskItemsCompletion(
  items: TaskMessageItem[],
  targetItemId: string,
  completed: boolean,
  completedByNickname: string | null,
): { items: TaskMessageItem[]; found: boolean } {
  let found = false;

  const nextItems = items.map((item) => {
    if (item.id === targetItemId) {
      found = true;
      return cascadeTaskItemCompletion(item, completed, completedByNickname);
    }

    if (item.children && item.children.length > 0) {
      const childResult = updateTaskItemsCompletion(item.children, targetItemId, completed, completedByNickname);
      if (childResult.found) {
        found = true;
        return syncParentTaskItemCompletion({
          ...item,
          children: childResult.items,
        });
      }
    }

    return item;
  });

  return {
    items: nextItems,
    found,
  };
}

function flattenGroupTaskItems(
  items: TaskMessageItem[],
  sectionTitle: string,
  assignee: string,
  parentPath: string[] = [],
): FlattenedTaskItemContext[] {
  return items.flatMap((item) => {
    const path = [...parentPath, item.text];
    const current: FlattenedTaskItemContext = {
      sectionTitle,
      assignee,
      path,
      item,
    };
    const children = item.children ? flattenGroupTaskItems(item.children, sectionTitle, assignee, path) : [];
    return [current, ...children];
  });
}

export function flattenTaskContentItems(taskContent: TaskMessageContent): FlattenedTaskItemContext[] {
  return taskContent.sections.flatMap((section) =>
    section.groups.flatMap((group) => flattenGroupTaskItems(group.items, section.title, group.assignee)),
  );
}

export function areAllTaskContentItemsCompleted(taskContent: TaskMessageContent): boolean {
  return taskContent.sections.every((section) =>
    section.groups.every((group) => group.items.every((item) => isTaskItemTreeCompleted(item))),
  );
}

export function updateTaskContentItemCompletion(
  taskContent: TaskMessageContent,
  targetItemId: string,
  completed: boolean,
  completedByNickname: string | null,
): { taskContent: TaskMessageContent; found: boolean } {
  let found = false;

  const nextSections = taskContent.sections.map((section) => ({
    ...section,
    groups: section.groups.map((group) => {
      const result = updateTaskItemsCompletion(group.items, targetItemId, completed, completedByNickname);
      if (result.found) {
        found = true;
      }

      return {
        ...group,
        items: result.items,
      };
    }),
  }));

  return {
    taskContent: {
      ...taskContent,
      sections: nextSections,
    },
    found,
  };
}
