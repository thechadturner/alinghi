const express = require("express");
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const { handleValidation } = require('../../shared/middleware/validation');
const controller = require('../controllers/events');
const router = express.Router();

/**
 * @route POST /api/event
 * @desc Add event
*/

router.post(
'/',
authenticate, 
[
	body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
	body("event_type").isString().withMessage('event_type is required').trim(),
	body("start_time").isISO8601().withMessage("Invalid start time format"),
	body("end_time").isISO8601().withMessage("Invalid end time format"),
	body("tags").isString().withMessage('tags is required').trim()
],
controller.addEvent
);

/**
 * @route POST /api/events/array
 * @desc Add array of events
 */

router.post(
'/array',
authenticate, 
[
	body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
	body('events').custom((events) => {
	if (!Array.isArray(events)) {
		throw new Error('events must be an array');
	}
	events.forEach((event, index) => {
		if (typeof event !== 'object' || event === null) {
			throw new Error(`Event at index ${index} must be a JSON object`);
		}
	
		// Define validation rules
		const validations = [
			{ key: 'event_type', type: 'string', check: v => typeof v === 'string' && v.trim() !== '' },
			{ key: 'start_time', type: 'datetime', check: v => typeof v === 'string' && !isNaN(Date.parse(v)) },
			{ key: 'end_time', type: 'datetime', check: v => typeof v === 'string' && !isNaN(Date.parse(v)) },
			{ key: 'tags', type: 'json', check: v => typeof v === 'object' && v !== null }
		];
	
		// Iterate through validation rules
		validations.forEach(({ key, type, check }) => {
			if (!event.hasOwnProperty(key)) {
				throw new Error(`Event at index ${index} is missing '${key}'`);
			}
			if (!check(event[key])) {
				throw new Error(`Event at index ${index} has an invalid '${key}' (expected ${type})`);
			}
		});
	});
	return true;
	}),
],
controller.addEvents
);

/**
 * @route POST /api/events/object
 * @desc Add Event JSON
 */

router.post(
	'/object',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	 	body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
		body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('desc').exists().withMessage('desc is required').bail().customSanitizer(value => String(value).trim()),
	  	body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim())
	],
	controller.addEventObject
);

/**
 * @route POST /api/events/row
 * @desc Add Event Row
 */

router.post(
	'/row',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
		body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
		body('agr_type').exists().withMessage('agr_type is required').bail().customSanitizer(value => String(value).trim()),
	  	body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim())
	],
	controller.addEventRow
);

/**
 * @route POST /api/events/rows
 * @desc Add Event Rows
 */

router.post(
	'/rows',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	  	body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
		body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
		body('agr_type').exists().withMessage('agr_type is required').bail().customSanitizer(value => String(value).trim()),
	  	body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim())
	],
	controller.addEventRows
);

/**
 * @route POST /api/events/rows
 * @desc Add Event Rows
 */

router.post(
	'/aggregates',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	  	body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim())
	],
	controller.addEventAggregates
);

/**
 * @route PUT /api/events/row
 * @desc Update Event Row
 */

router.put(
	'/row',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
	  	body('agr_type').exists().withMessage('agr_type is required').bail().customSanitizer(value => String(value).trim()),
	  	body('column').exists().withMessage('column is required').bail().customSanitizer(value => String(value).trim()),
	  	body('value').exists().withMessage('value is required').bail().customSanitizer(value => String(value).trim())
	],
	controller.updateEventRow
);

/**
 * @route PUT /api/events/rows
 * @desc Update Event Rows
 */

router.put(
	'/rows',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	  	body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
		body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
	  	body('agr_type').exists().withMessage('agr_type is required').bail().customSanitizer(value => String(value).trim()),
	  	body('json_str').exists().withMessage('json_str is required').bail().customSanitizer(value => String(value).trim())
	],
	controller.updateEventRows
);

/**
 * @route PUT /api/events/maneuver-loss
 * @desc Update Maneuver Loss Values
 */

router.put(
	'/maneuver-loss',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
		body('vmg_applied').exists().withMessage('vmg_applied is required').bail().isFloat().withMessage('vmg_applied must be a number').toFloat(),
		body('loss_total_vmg').exists().withMessage('loss_total_vmg is required').bail().isFloat().withMessage('loss_total_vmg must be a number').toFloat(),
		body('loss_inv_vmg').exists().withMessage('loss_inv_vmg is required').bail().isFloat().withMessage('loss_inv_vmg must be a number').toFloat(),
		body('loss_turn_vmg').exists().withMessage('loss_turn_vmg is required').bail().isFloat().withMessage('loss_turn_vmg must be a number').toFloat(),
		body('loss_build_vmg').exists().withMessage('loss_build_vmg is required').bail().isFloat().withMessage('loss_build_vmg must be a number').toFloat()
	],
	controller.updateManeuverLossValues
);

/**
 * @route PUT /api/events/tags
 * @desc Update Event Tags
 */

router.put(
	'/tags',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
		body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('events').custom((events) => {
			if (!Array.isArray(events)) {
				throw new Error('events must be an array');
			}
			if (events.length === 0) {
				throw new Error('events array cannot be empty');
			}
			events.forEach((eventId, index) => {
				if (typeof eventId !== 'number' || !Number.isInteger(eventId) || eventId <= 0) {
					throw new Error(`Event ID at index ${index} must be a positive integer`);
				}
			});
			return true;
		}),
		body('event_types').custom((event_types) => {
			if (!Array.isArray(event_types)) {
				throw new Error('event_types must be an array');
			}
			if (event_types.length === 0) {
				throw new Error('event_types array cannot be empty');
			}
			event_types.forEach((eventType, index) => {
				if (typeof eventType !== 'string' || eventType.trim() === '') {
					throw new Error(`Event type at index ${index} must be a non-empty string`);
				}
			});
			return true;
		}),
		body('key').exists().withMessage('key is required').bail().customSanitizer(value => String(value).trim()),
		body('value').exists().withMessage('value is required')
	],
	controller.updateEventTags
);

/**
 * @route PUT /api/events/dataset-event-tags
 * @desc Merge tags into the DATASET event for a given dataset_id (e.g. Dataset_type, Race_type).
 */
router.put(
	'/dataset-event-tags',
	authenticate,
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
		body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
		body('tags').exists().withMessage('tags is required').bail().custom((value) => typeof value === 'object' && value !== null && !Array.isArray(value)),
	],
	handleValidation,
	controller.mergeDatasetEventTags
);

/**
 * @route PUT /api/events/sync-dataset-events
 * @desc Sync dataset events (CREW/HEADSAIL) from payload; only update/insert/delete where changed.
 */

router.put(
	'/sync-dataset-events',
	authenticate,
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
		body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
		body('events').custom((events) => {
			if (!Array.isArray(events)) {
				throw new Error('events must be an array');
			}
			events.forEach((ev, index) => {
				if (typeof ev !== 'object' || ev === null) {
					throw new Error(`Event at index ${index} must be an object`);
				}
				if (ev.EventType !== undefined && typeof ev.EventType !== 'string') {
					throw new Error(`Event at index ${index} EventType must be a string`);
				}
				if (ev.Start !== undefined && typeof ev.Start !== 'string' && !(ev.Start instanceof Date)) {
					throw new Error(`Event at index ${index} Start must be a string or Date`);
				}
				if (ev.End !== undefined && typeof ev.End !== 'string' && !(ev.End instanceof Date)) {
					throw new Error(`Event at index ${index} End must be a string or Date`);
				}
			});
			return true;
		}),
	],
	controller.syncDatasetEvents
);

/**
 * @route DELETE /api/events
 * @desc Delete events
 */

router.delete(
	'/',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
		body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
		body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
		body('events').custom((events) => {
		if (!Array.isArray(events)) {
			throw new Error('events must be an array');
		}
		events.forEach((event, index) => {
			if (typeof event !== 'object' || event === null) {
				throw new Error(`Event at index ${index} must be a JSON object`);
			}
		
			// Define validation rules
			const validations = [
				{ key: 'event_type', type: 'string', check: v => typeof v === 'string' && v.trim() !== '' },
				{ key: 'start_time', type: 'datetime', check: v => typeof v === 'string' && !isNaN(Date.parse(v)) },
				{ key: 'end_time', type: 'datetime', check: v => typeof v === 'string' && !isNaN(Date.parse(v)) },
				{ key: 'duration', type: 'double', check: v => typeof v === 'number' && !isNaN(v) },
				{ key: 'tags', type: 'json', check: v => typeof v === 'object' && v !== null }
			];
		
			// Iterate through validation rules
			validations.forEach(({ key, type, check }) => {
				if (!event.hasOwnProperty(key)) {
					throw new Error(`Event at index ${index} is missing '${key}'`);
				}
				if (!check(event[key])) {
					throw new Error(`Event at index ${index} has an invalid '${key}' (expected ${type})`);
				}
			});
		});
		return true;
		}),
	],
	controller.removeEvents
	);

/**
 * @route DELETE /api/events/rows
 * @desc Delete Event Rows
 */

router.delete(
	'/rows',
	authenticate, 
	[
		body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
	  	body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
	  	body('event_id').exists().withMessage('event_id is required').bail().isInt().withMessage('event_id must be an integer').toInt(),
	  	body('table').exists().withMessage('table is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid table name');} return true;}).customSanitizer((value) => String(value).trim()),
	],
	controller.removeEventRows
);

/**
 * @route DELETE /api/events/by_event_type
 * @desc Delete events by event_type
 */

router.delete(
	'/by_event_type',
	authenticate,
	[
		body('class_name')
			.exists().withMessage('class_name is required')
			.bail()
			.custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;})
			.customSanitizer((value) => String(value).trim()),
		body('project_id')
			.exists().withMessage('project_id is required')
			.bail()
			.isInt().withMessage('project_id must be an integer')
			.toInt(),
		body('dataset_id')
			.exists().withMessage('dataset_id is required')
			.bail()
			.isInt().withMessage('dataset_id must be an integer')
			.toInt(),
		body('event_types').custom((events) => {
			if (!Array.isArray(events)) {
			throw new Error('event_types must be an array');
			}
			return true; 
	  })
	],
	controller.removeEventsByType
  );

module.exports = router;