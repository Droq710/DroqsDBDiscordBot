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
