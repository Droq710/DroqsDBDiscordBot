const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCommands } = require('../src/discord/registerCommands');

test('autopost command registration includes daily forecast configuration options', () => {
  const commands = buildCommands();
  const autopostCommand = commands.find((command) => command.name === 'autopost');
  const dailyForecastSubcommand = autopostCommand.options.find(
    (option) => option.name === 'daily-forecast'
  );

  assert.ok(dailyForecastSubcommand);
  assert.deepEqual(
    dailyForecastSubcommand.options.map((option) => option.name),
    ['enabled', 'channel', 'time', 'count']
  );
  assert.equal(
    dailyForecastSubcommand.options.find((option) => option.name === 'enabled').required,
    true
  );
  assert.equal(
    dailyForecastSubcommand.options.find((option) => option.name === 'count').max_value,
    10
  );
});

test('alert command registration includes flight personalization options', () => {
  const commands = buildCommands();
  const alertCommand = commands.find((command) => command.name === 'alert');
  const createSubcommand = alertCommand.options.find((option) => option.name === 'create');
  const flightTypeOption = createSubcommand.options.find((option) => option.name === 'flight_type');
  const capacityOption = createSubcommand.options.find((option) => option.name === 'capacity');

  assert.ok(flightTypeOption);
  assert.ok(capacityOption);
  assert.deepEqual(
    flightTypeOption.choices.map((choice) => choice.value),
    ['standard', 'airstrip', 'private', 'business']
  );
  assert.equal(capacityOption.min_value, 1);
  assert.equal(capacityOption.max_value, 100);
});
