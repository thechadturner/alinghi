/**
 * Data Validator Worker
 * 
 * Handles data validation operations including:
 * - Schema validation
 * - Data type validation
 * - Range validation
 * - Format validation
 * - Custom validation rules
 */

import type { 
  WorkerMessage, 
  WorkerResponse, 
  ValidatableDataItem, 
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ValidationStatistics,
  ValidationRule,
  FieldSchema,
  DataType,
  FormatType
} from './types';

interface ValidationConfig {
  schema?: Record<string, FieldSchema>;
  rules?: ValidationRule[];
  strict?: boolean;
  returnDetails?: boolean;
}

interface ValidationSummary {
  valid: boolean;
  totalErrors: number;
  totalWarnings: number;
  errorRate: number;
  mostCommonErrors: CommonError[];
  validationTime: number;
}

interface CommonError {
  field: string;
  rule: string;
  count: number;
}

// Worker message handler
self.onmessage = function(e: MessageEvent<WorkerMessage<ValidatableDataItem[], ValidationConfig>>) {
  const { id, type, data, config } = e.data;
  
  try {
    let result: ValidationResult;
    
    switch (type) {
      case 'data-validator':
        result = validateData(data, config);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send result back to main thread
    const response: WorkerResponse<ValidationResult> = {
      id,
      type: 'success',
      result,
      duration: Date.now() - e.data.timestamp
    };
    self.postMessage(response);
    
  } catch (error) {
    // Send error back to main thread
    const response: WorkerResponse = {
      id,
      type: 'error',
      error: (error as Error).message,
      duration: Date.now() - e.data.timestamp
    };
    self.postMessage(response);
  }
};

/**
 * Validate data against schema and rules
 */
function validateData(data: ValidatableDataItem[], config: ValidationConfig = {}): ValidationResult {
  if (!Array.isArray(data)) {
    throw new Error('Data must be an array');
  }

  const {
    schema = {},
    rules = [],
    strict = false,
    returnDetails = true
  } = config;

  const validationResult: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    statistics: {
      totalItems: data.length,
      validItems: 0,
      invalidItems: 0,
      fieldErrors: {},
      validationTime: 0
    }
  };

  const startTime = Date.now();

  // Validate each item
  data.forEach((item, index) => {
    const itemValidation = validateItem(item, schema, rules, strict);
    
    if (itemValidation.valid) {
      validationResult.statistics.validItems++;
    } else {
      validationResult.statistics.invalidItems++;
      validationResult.valid = false;
    }

    // Collect errors and warnings
    itemValidation.errors.forEach(error => {
      validationResult.errors.push({
        index,
        field: error.field,
        message: error.message,
        value: error.value,
        rule: error.rule
      });

      // Track field errors
      if (!validationResult.statistics.fieldErrors[error.field]) {
        validationResult.statistics.fieldErrors[error.field] = 0;
      }
      validationResult.statistics.fieldErrors[error.field]++;
    });

    itemValidation.warnings.forEach(warning => {
      validationResult.warnings.push({
        index,
        field: warning.field,
        message: warning.message,
        value: warning.value,
        rule: warning.rule
      });
    });
  });

  validationResult.statistics.validationTime = Date.now() - startTime;

  return validationResult;
}

/**
 * Validate a single data item
 */
function validateItem(item: ValidatableDataItem, schema: Record<string, FieldSchema>, rules: ValidationRule[], strict: boolean): {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
} {
  const result = {
    valid: true,
    errors: [] as ValidationError[],
    warnings: [] as ValidationWarning[]
  };

  // Validate against schema
  if (Object.keys(schema).length > 0) {
    const schemaValidation = validateSchema(item, schema, strict);
    result.errors.push(...schemaValidation.errors);
    result.warnings.push(...schemaValidation.warnings);
  }

  // Validate against custom rules
  rules.forEach(rule => {
    const ruleValidation = validateRule(item, rule);
    if (ruleValidation.error) {
      result.errors.push(ruleValidation.error);
    }
    if (ruleValidation.warning) {
      result.warnings.push(ruleValidation.warning);
    }
  });

  result.valid = result.errors.length === 0;

  return result;
}

/**
 * Validate item against schema
 */
function validateSchema(item: ValidatableDataItem, schema: Record<string, FieldSchema>, strict: boolean): {
  errors: ValidationError[];
  warnings: ValidationWarning[];
} {
  const result = {
    errors: [] as ValidationError[],
    warnings: [] as ValidationWarning[]
  };

  // Check required fields
  Object.entries(schema).forEach(([field, fieldSchema]) => {
    const value = item[field];
    const isRequired = fieldSchema.required || false;
    const isNullable = fieldSchema.nullable || false;

    // Check if required field is missing
    if (isRequired && (value === undefined || value === null)) {
      result.errors.push({
        index: -1, // Will be set by caller
        field,
        message: `Required field '${field}' is missing`,
        value,
        rule: 'required'
      });
      return;
    }

    // Check if field is null when not nullable
    if (!isNullable && value === null) {
      result.errors.push({
        index: -1, // Will be set by caller
        field,
        message: `Field '${field}' cannot be null`,
        value,
        rule: 'nullable'
      });
      return;
    }

    // Skip validation if value is null/undefined and field is optional
    if (value === undefined || value === null) {
      return;
    }

    // Validate data type
    if (fieldSchema.type) {
      const typeValidation = validateType(value, fieldSchema.type, field);
      if (typeValidation.error) {
        result.errors.push(typeValidation.error);
      }
    }

    // Validate format
    if (fieldSchema.format) {
      const formatValidation = validateFormat(value, fieldSchema.format, field);
      if (formatValidation.error) {
        result.errors.push(formatValidation.error);
      }
    }

    // Validate range
    if (fieldSchema.min !== undefined || fieldSchema.max !== undefined) {
      const rangeValidation = validateRange(value, fieldSchema, field);
      if (rangeValidation.error) {
        result.errors.push(rangeValidation.error);
      }
    }

    // Validate pattern
    if (fieldSchema.pattern) {
      const patternValidation = validatePattern(value, fieldSchema.pattern, field);
      if (patternValidation.error) {
        result.errors.push(patternValidation.error);
      }
    }

    // Validate enum
    if (fieldSchema.enum) {
      const enumValidation = validateEnum(value, fieldSchema.enum, field);
      if (enumValidation.error) {
        result.errors.push(enumValidation.error);
      }
    }
  });

  // Check for extra fields in strict mode
  if (strict) {
    const schemaFields = Object.keys(schema);
    Object.keys(item).forEach(field => {
      if (!schemaFields.includes(field)) {
        result.warnings.push({
          index: -1, // Will be set by caller
          field,
          message: `Unexpected field '${field}' found`,
          value: item[field],
          rule: 'strict'
        });
      }
    });
  }

  return result;
}

/**
 * Validate data type
 */
function validateType(value: any, expectedType: DataType, field: string): { error: ValidationError | null } {
  const actualType = typeof value;
  
  switch (expectedType) {
    case 'string':
      if (actualType !== 'string') {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a string, got ${actualType}`,
            value,
            rule: 'type'
          }
        };
      }
      break;
      
    case 'number':
      if (actualType !== 'number' || isNaN(value)) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a number, got ${actualType}`,
            value,
            rule: 'type'
          }
        };
      }
      break;
      
    case 'boolean':
      if (actualType !== 'boolean') {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a boolean, got ${actualType}`,
            value,
            rule: 'type'
          }
        };
      }
      break;
      
    case 'date':
      if (!(value instanceof Date) && isNaN(new Date(value).getTime())) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a valid date`,
            value,
            rule: 'type'
          }
        };
      }
      break;
      
    case 'array':
      if (!Array.isArray(value)) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be an array, got ${actualType}`,
            value,
            rule: 'type'
          }
        };
      }
      break;
      
    case 'object':
      if (actualType !== 'object' || Array.isArray(value)) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be an object, got ${actualType}`,
            value,
            rule: 'type'
          }
        };
      }
      break;
  }

  return { error: null };
}

/**
 * Validate format
 */
function validateFormat(value: any, format: FormatType, field: string): { error: ValidationError | null } {
  switch (format) {
    case 'email':
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a valid email address`,
            value,
            rule: 'format'
          }
        };
      }
      break;
      
    case 'url':
      try {
        new URL(value);
      } catch (error) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a valid URL`,
            value,
            rule: 'format'
          }
        };
      }
      break;
      
    case 'uuid':
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(value)) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a valid UUID`,
            value,
            rule: 'format'
          }
        };
      }
      break;
      
    case 'date':
      if (isNaN(new Date(value).getTime())) {
        return {
          error: {
            index: -1, // Will be set by caller
            field,
            message: `Field '${field}' must be a valid date`,
            value,
            rule: 'format'
          }
        };
      }
      break;
  }

  return { error: null };
}

/**
 * Validate range
 */
function validateRange(value: any, schema: FieldSchema, field: string): { error: ValidationError | null } {
  const numValue = Number(value);
  
  if (isNaN(numValue)) {
    return { error: null }; // Let type validation handle this
  }

  if (schema.min !== undefined && numValue < schema.min) {
      return {
        error: {
          index: -1, // Will be set by caller
          field,
          message: `Field '${field}' must be at least ${schema.min}, got ${numValue}`,
          value,
          rule: 'range'
        }
      };
  }

  if (schema.max !== undefined && numValue > schema.max) {
      return {
        error: {
          index: -1, // Will be set by caller
          field,
          message: `Field '${field}' must be at most ${schema.max}, got ${numValue}`,
          value,
          rule: 'range'
        }
      };
  }

  return { error: null };
}

/**
 * Validate pattern
 */
function validatePattern(value: any, pattern: string, field: string): { error: ValidationError | null } {
  const regex = new RegExp(pattern);
  if (!regex.test(value)) {
    return {
      error: {
        index: -1, // Will be set by caller
        field,
        message: `Field '${field}' does not match required pattern`,
        value,
        rule: 'pattern'
      }
    };
  }

  return { error: null };
}

/**
 * Validate enum
 */
function validateEnum(value: any, enumValues: any[], field: string): { error: ValidationError | null } {
  if (!enumValues.includes(value)) {
    return {
      error: {
        index: -1, // Will be set by caller
        field,
        message: `Field '${field}' must be one of: ${enumValues.join(', ')}`,
        value,
        rule: 'enum'
      }
    };
  }

  return { error: null };
}

/**
 * Validate custom rule
 */
function validateRule(item: ValidatableDataItem, rule: ValidationRule): { error: ValidationError | null; warning: ValidationWarning | null } {
  try {
    const result = rule.validator(item, rule);
    
    if (result === false) {
      return {
        error: {
          index: -1, // Will be set by caller
          field: rule.field || 'unknown',
          message: rule.message || 'Custom validation failed',
          value: item[rule.field],
          rule: rule.name || 'custom'
        },
        warning: null
      };
    }
    
    if (result === 'warning') {
      return {
        error: null,
        warning: {
          index: -1, // Will be set by caller
          field: rule.field || 'unknown',
          message: rule.message || 'Custom validation warning',
          value: item[rule.field],
          rule: rule.name || 'custom'
        }
      };
    }
    
    return { error: null, warning: null };
  } catch (error) {
      return {
        error: {
          index: -1, // Will be set by caller
          field: rule.field || 'unknown',
          message: `Custom validation error: ${(error as Error).message}`,
          value: item[rule.field],
          rule: rule.name || 'custom'
        },
        warning: null
      };
  }
}

/**
 * Create a validation rule
 */
function createRule(name: string, field: string, validator: (item: ValidatableDataItem, rule: ValidationRule) => boolean | 'warning', message: string): ValidationRule {
  return {
    name,
    field,
    validator,
    message
  };
}

/**
 * Create common validation rules
 */
function createCommonRules(): ValidationRule[] {
  return [
    // Non-empty string rule
    createRule('nonEmpty', 'string', (item, rule) => {
      const value = item[rule.field];
      return value !== null && value !== undefined && value !== '';
    }, 'Field cannot be empty'),
    
    // Positive number rule
    createRule('positive', 'number', (item, rule) => {
      const value = Number(item[rule.field]);
      return !isNaN(value) && value > 0;
    }, 'Field must be a positive number'),
    
    // Future date rule
    createRule('futureDate', 'date', (item, rule) => {
      const value = new Date(item[rule.field]);
      return !isNaN(value.getTime()) && value > new Date();
    }, 'Field must be a future date'),
    
    // Array length rule
    createRule('arrayLength', 'array', (item, rule) => {
      const value = item[rule.field];
      return Array.isArray(value) && value.length >= ((rule as any).min || 0) && value.length <= ((rule as any).max || Infinity);
    }, 'Array length must be within specified range')
  ];
}

/**
 * Get validation summary
 */
function getValidationSummary(validationResult: ValidationResult): ValidationSummary {
  const { valid, errors, warnings, statistics } = validationResult;
  
  return {
    valid,
    totalErrors: errors.length,
    totalWarnings: warnings.length,
    errorRate: statistics.totalItems > 0 ? (statistics.invalidItems / statistics.totalItems) * 100 : 0,
    mostCommonErrors: getMostCommonErrors(errors),
    validationTime: statistics.validationTime
  };
}

/**
 * Get most common errors
 */
function getMostCommonErrors(errors: ValidationError[]): CommonError[] {
  const errorCounts: Record<string, number> = {};
  
  errors.forEach(error => {
    const key = `${error.field}:${error.rule}`;
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  });
  
  return Object.entries(errorCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([key, count]) => {
      const [field, rule] = key.split(':');
      return { field, rule, count };
    });
}
