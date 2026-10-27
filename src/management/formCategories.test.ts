import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGEMENT_FORMS } from './forms';
import { groupFormFields } from './formCategories';

test('all management form categories preserve every original field and its validation metadata', () => {
  for (const form of Object.values(MANAGEMENT_FORMS)) {
    const grouped = groupFormFields(form.fields).flatMap(group => group.fields);
    assert.equal(grouped.length, form.fields.length, form.title);
    for (const field of form.fields) assert.equal(grouped.filter(candidate => candidate === field).length, form.fields.filter(candidate => candidate === field).length, `${form.title}: ${field.name}`);
  }
});

test('task form separates line location, schedule and object links', () => {
  const groups = groupFormFields(MANAGEMENT_FORMS['task.create'].fields);
  const categoryOf = (name: string) => groups.find(group => group.fields.some(field => field.name === name))?.id;
  assert.equal(categoryOf('name'), 'basic');
  assert.equal(categoryOf('railwayLine'), 'location');
  assert.equal(categoryOf('workWindowStart'), 'schedule');
  assert.equal(categoryOf('resourceIds'), 'relations');
});
