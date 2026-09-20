import '../css/PanelDataTable.css';

import React from 'react';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/lib/table';
import type { DataTableRow } from '../interfaces';

export interface PanelDataTableProps {
  dataTable: DataTableRow[];
}

class PanelDataTable extends React.Component<PanelDataTableProps> {
  constructor(props: PanelDataTableProps) {
    super(props);
  }

  render() {
    const table = this.props.dataTable;
    const columns: ColumnsType<DataTableRow> = [];
    const displayTable: DataTableRow[] = [];
    if (table.length > 0) {
      // Setting table columns
      const columnNames = Object.keys(table[0]);
      for (const name of columnNames) {
        const column = {
          key: name,
          title: name,
          dataIndex: name,
          ellipsis: true,
        };
        columns.push(column);
      }

      // Format data in table
      for (let rowId = 0; rowId < table.length; rowId++) {
        const displayRow: DataTableRow = Object();
        displayRow['rid'] = rowId;
        displayTable.push(displayRow);
      }
    }

    return (
      <Table
        className="data-table"
        bordered
        rowKey="rid"
        columns={columns}
        dataSource={displayTable}
        pagination={{ position: ['topRight'], size: 'small', defaultPageSize: 20 }}
        scroll={{ x: true, y: 152 }}
        size="small"
      />
    );
  }
}

export default PanelDataTable;
