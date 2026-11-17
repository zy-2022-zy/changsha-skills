import path from 'node:path';

export type FilingType = 'STANDARD' | '5G';

export function filingTypeForFile(filePath: string): FilingType {
  return path.basename(filePath).toUpperCase().includes('5G') ? '5G' : 'STANDARD';
}

export function uploadNavigation(filePath: string): [string, string, string] {
  return filingTypeForFile(filePath) === '5G'
    ? ['5G端口上报管理', '5G端口信息报送', '5G真实端口数据管理']
    : ['端口上报管理', '端口信息报送', '真实端口数据管理'];
}
