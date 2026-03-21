/**
 * Example schema definitions for HuniDB
 */

import { defineTable, index } from '../src/index.js';

// User table schema
export const usersTable = defineTable('users', {
  id: {
    type: 'TEXT',
    primaryKey: true,
  },
  username: {
    type: 'TEXT',
    notNull: true,
    unique: true,
  },
  email: {
    type: 'TEXT',
    notNull: true,
    unique: true,
  },
  password_hash: {
    type: 'TEXT',
    notNull: true,
  },
  created_at: {
    type: 'INTEGER',
    notNull: true,
    default: Date.now(),
  },
  updated_at: {
    type: 'INTEGER',
  },
}, {
  indexes: [
    index('idx_users_username', ['username']),
    index('idx_users_email', ['email']),
    index('idx_users_created', ['created_at']),
  ],
});

// Posts table schema
export const postsTable = defineTable('posts', {
  id: {
    type: 'INTEGER',
    primaryKey: true,
    autoIncrement: true,
  },
  user_id: {
    type: 'TEXT',
    notNull: true,
    references: 'users.id',
    onDelete: 'CASCADE',
  },
  title: {
    type: 'TEXT',
    notNull: true,
  },
  content: {
    type: 'TEXT',
    notNull: true,
  },
  published: {
    type: 'INTEGER',
    notNull: true,
    default: 0,
  },
  created_at: {
    type: 'INTEGER',
    notNull: true,
  },
}, {
  indexes: [
    index('idx_posts_user', ['user_id']),
    index('idx_posts_published', ['published', 'created_at']),
  ],
});

// Comments table schema
export const commentsTable = defineTable('comments', {
  id: {
    type: 'INTEGER',
    primaryKey: true,
    autoIncrement: true,
  },
  post_id: {
    type: 'INTEGER',
    notNull: true,
    references: 'posts.id',
    onDelete: 'CASCADE',
  },
  user_id: {
    type: 'TEXT',
    notNull: true,
    references: 'users.id',
    onDelete: 'CASCADE',
  },
  content: {
    type: 'TEXT',
    notNull: true,
  },
  created_at: {
    type: 'INTEGER',
    notNull: true,
  },
}, {
  indexes: [
    index('idx_comments_post', ['post_id']),
    index('idx_comments_user', ['user_id']),
  ],
});

// Tags table schema with WITHOUT ROWID optimization
export const tagsTable = defineTable('tags', {
  id: {
    type: 'TEXT',
    primaryKey: true,
  },
  name: {
    type: 'TEXT',
    notNull: true,
    unique: true,
  },
  slug: {
    type: 'TEXT',
    notNull: true,
    unique: true,
  },
}, {
  withoutRowId: true,
});

// Post tags junction table
export const postTagsTable = defineTable('post_tags', {
  post_id: {
    type: 'INTEGER',
    notNull: true,
    references: 'posts.id',
    onDelete: 'CASCADE',
  },
  tag_id: {
    type: 'TEXT',
    notNull: true,
    references: 'tags.id',
    onDelete: 'CASCADE',
  },
  created_at: {
    type: 'INTEGER',
    notNull: true,
  },
}, {
  indexes: [
    index('idx_post_tags_post', ['post_id']),
    index('idx_post_tags_tag', ['tag_id']),
    index('idx_post_tags_unique', ['post_id', 'tag_id'], { unique: true }),
  ],
});

// Sessions table for authentication
export const sessionsTable = defineTable('sessions', {
  id: {
    type: 'TEXT',
    primaryKey: true,
  },
  user_id: {
    type: 'TEXT',
    notNull: true,
    references: 'users.id',
    onDelete: 'CASCADE',
  },
  token: {
    type: 'TEXT',
    notNull: true,
    unique: true,
  },
  expires_at: {
    type: 'INTEGER',
    notNull: true,
  },
  created_at: {
    type: 'INTEGER',
    notNull: true,
  },
}, {
  indexes: [
    index('idx_sessions_user', ['user_id']),
    index('idx_sessions_token', ['token']),
    index('idx_sessions_expires', ['expires_at']),
  ],
});

// Settings table with JSON data
export const settingsTable = defineTable('settings', {
  key: {
    type: 'TEXT',
    primaryKey: true,
  },
  value: {
    type: 'JSON',
    notNull: true,
  },
  category: {
    type: 'TEXT',
  },
  updated_at: {
    type: 'INTEGER',
    notNull: true,
  },
}, {
  indexes: [
    index('idx_settings_category', ['category']),
  ],
});

// Export all schemas
export const schemas = {
  users: usersTable,
  posts: postsTable,
  comments: commentsTable,
  tags: tagsTable,
  postTags: postTagsTable,
  sessions: sessionsTable,
  settings: settingsTable,
};

