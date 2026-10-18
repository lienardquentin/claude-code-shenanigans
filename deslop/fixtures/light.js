// read the config file
const config = readConfigFile()

export const handle = async (data) => {
  await send(data, config).catch(() => {})
}
